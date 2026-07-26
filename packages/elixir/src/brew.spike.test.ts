import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { isBrewed, openaiBrewer } from "./brewers.ts";
import {
  createFallbackFetch,
  resolveFallback,
  traceparentFrom,
  XYBRID_ERROR_HEADER,
} from "./gateway.ts";
import { init } from "./init.ts";

/** Minimal structural stand-in for an OpenAI Node SDK client. */
function fakeOpenAI(fetchImpl: typeof fetch, baseURL = "https://api.openai.com/v1") {
  return {
    baseURL,
    fetch: fetchImpl,
    chat: { completions: { create: () => {} } },
  };
}

/** Mock fetch that answers by host: gateway → `gatewayStatus`, upstream → 200. */
function mockTransport(gatewayStatus: number) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const isGateway = url.includes("gateway.xybrid.ai");
    const status = isGateway ? gatewayStatus : 200;
    const headers =
      isGateway && status !== 200 ? { [XYBRID_ERROR_HEADER]: "mock_gateway_error" } : undefined;
    return new Response(JSON.stringify({ ok: status === 200 }), { status, headers });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

describe("brew — gateway routing + fallback (spike)", () => {
  it("routes through the gateway and swaps baseURL", async () => {
    const { fetchImpl, calls } = mockTransport(200);
    const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
    const client = sdk.brew(fakeOpenAI(fetchImpl));

    expect(client.baseURL).toBe("https://gateway.xybrid.ai/openai/v1");

    const res = await client.fetch("https://gateway.xybrid.ai/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o" }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://gateway.xybrid.ai/openai/v1/chat/completions"]);
  });

  it("falls back to the provider when the gateway returns 503", async () => {
    const { fetchImpl, calls } = mockTransport(503);
    const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
    const client = sdk.brew(fakeOpenAI(fetchImpl));

    const res = await client.fetch("https://gateway.xybrid.ai/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o" }),
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      "https://gateway.xybrid.ai/openai/v1/chat/completions", // gateway attempt (503)
      "https://api.openai.com/v1/chat/completions", // direct fallback
    ]);
  });

  it("opens the circuit and skips the gateway after repeated failures", async () => {
    const { fetchImpl, calls } = mockTransport(503);
    const sdk = init({
      apiKey: "xyb_test",
      gateway: "https://gateway.xybrid.ai",
      fallback: { circuit: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 } },
    });
    const client = sdk.brew(fakeOpenAI(fetchImpl));
    const url = "https://gateway.xybrid.ai/openai/v1/chat/completions";
    const init2 = { method: "POST", body: JSON.stringify({ model: "gpt-4o" }) };

    await client.fetch(url, init2); // failure 1: gateway + fallback
    await client.fetch(url, init2); // failure 2: gateway + fallback → trips breaker
    calls.length = 0;
    await client.fetch(url, init2); // circuit open: straight to upstream, no gateway attempt

    expect(calls).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("throws when no brewer handles the client", () => {
    const sdk = init({ apiKey: "xyb_test" });
    expect(() => sdk.brew({ notAClient: true })).toThrow(/no brewer registered/);
  });
});

describe("brew — idempotency", () => {
  // Regression: `route()` read the *live* baseURL and wrapped the *live* fetch,
  // so a second brew (module reload, a brew on a per-request path) stacked a
  // second gateway transport on top of the first — two correlation spans per
  // request, and an upstreamPrefix pointing at the gateway, not the provider.
  it("is a no-op on an already-brewed client", () => {
    const { fetchImpl } = mockTransport(200);
    const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
    const client = fakeOpenAI(fetchImpl);

    sdk.brew(client);
    const afterFirst = { baseURL: client.baseURL, fetch: client.fetch };
    sdk.brew(client);

    expect(client.baseURL).toBe(afterFirst.baseURL);
    expect(client.fetch).toBe(afterFirst.fetch); // transport not re-wrapped
    expect(isBrewed(client)).toBe(true);
  });

  it("emits exactly one correlation span per request after a double brew", async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memory)],
    });
    trace.setGlobalTracerProvider(provider);
    try {
      const { fetchImpl } = mockTransport(200);
      const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
      const client = fakeOpenAI(fetchImpl);
      sdk.brew(client);
      sdk.brew(client);

      await client.fetch("https://gateway.xybrid.ai/openai/v1/chat/completions", {
        method: "POST",
      });

      expect(memory.getFinishedSpans().map((s) => s.name)).toEqual(["xybrid openai"]);
    } finally {
      trace.disable();
    }
  });

  it("still falls back to the real provider after a double brew", async () => {
    const { fetchImpl, calls } = mockTransport(503);
    const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
    const client = fakeOpenAI(fetchImpl);
    sdk.brew(client);
    sdk.brew(client);

    await client.fetch("https://gateway.xybrid.ai/openai/v1/chat/completions", { method: "POST" });

    // The second brew must not have rewritten upstream to the gateway itself.
    expect(calls).toEqual([
      "https://gateway.xybrid.ai/openai/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]);
  });

  it("can enable instrumentation after an initial route-only brew", () => {
    const originalInstrument = openaiBrewer.instrument;
    const instrument = vi.fn();
    openaiBrewer.instrument = instrument;
    try {
      const { fetchImpl } = mockTransport(200);
      const sdk = init({ apiKey: "xyb_test", gateway: "https://gateway.xybrid.ai" });
      const client = fakeOpenAI(fetchImpl);

      sdk.brew(client, { instrument: false });
      const routedFetch = client.fetch;
      sdk.brew(client);

      expect(client.fetch).toBe(routedFetch);
      expect(instrument).toHaveBeenCalledOnce();
      expect(instrument).toHaveBeenCalledWith(client);
    } finally {
      openaiBrewer.instrument = originalInstrument;
    }
  });

  it("does not mark a client that no brewer could route", () => {
    expect(isBrewed({ notAClient: true })).toBe(false);
    expect(isBrewed(null)).toBe(false);
  });
});

describe("brew — traceparent injection (Mode C join key)", () => {
  /** Mock fetch that records the headers of every attempt. */
  function headerCapturingTransport(gatewayStatus: number) {
    const attempts: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (url: string, reqInit?: RequestInit) => {
      attempts.push({ url, headers: new Headers(reqInit?.headers) });
      const isGateway = url.includes("gateway.xybrid.ai");
      const status = isGateway ? gatewayStatus : 200;
      const headers =
        isGateway && status !== 200 ? { [XYBRID_ERROR_HEADER]: "mock_gateway_error" } : undefined;
      return new Response("{}", { status, headers });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, attempts };
  }

  function fallbackFetchWith(fetchImpl: typeof fetch, tracer?: ReturnType<BasicTracerProvider["getTracer"]>) {
    return createFallbackFetch({
      fetchImpl,
      gatewayPrefix: "https://gateway.xybrid.ai/openai/v1",
      upstreamPrefix: "https://api.openai.com/v1",
      system: "openai",
      apiKey: "xyb_test",
      policy: resolveFallback(),
      tracer,
    });
  }

  it("sends a traceparent matching the correlation span on the gateway attempt", async () => {
    const provider = new BasicTracerProvider();
    const { fetchImpl, attempts } = headerCapturingTransport(200);
    const xfetch = fallbackFetchWith(fetchImpl, provider.getTracer("test"));

    await xfetch("https://gateway.xybrid.ai/openai/v1/chat/completions", { method: "POST" });

    expect(attempts).toHaveLength(1);
    const traceparent = attempts[0]!.headers.get("traceparent");
    // W3C shape, non-zero ids — the gateway will parse this and land the same
    // (trace_id, span_id) on its metering event as the exported span carries.
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(traceparent).not.toMatch(/^00-0{32}-/);
  });

  it("omits traceparent when only the no-op tracer is available", async () => {
    // No provider registered → invalid span context → nothing is exported, so
    // there is nothing to join; the gateway mints its own trace identity.
    const { fetchImpl, attempts } = headerCapturingTransport(200);
    const xfetch = fallbackFetchWith(fetchImpl);

    await xfetch("https://gateway.xybrid.ai/openai/v1/chat/completions", { method: "POST" });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.headers.get("traceparent")).toBeNull();
    expect(attempts[0]!.headers.get("x-xybrid-key")).toBe("xyb_test");
  });

  it("respects a traceparent the app's own instrumentation already set", async () => {
    const provider = new BasicTracerProvider();
    const existing = "00-11111111111111111111111111111111-2222222222222222-01";
    const { fetchImpl, attempts } = headerCapturingTransport(200);
    const xfetch = fallbackFetchWith(fetchImpl, provider.getTracer("test"));

    await xfetch("https://gateway.xybrid.ai/openai/v1/chat/completions", {
      method: "POST",
      headers: { traceparent: existing },
    });

    expect(attempts[0]!.headers.get("traceparent")).toBe(existing);
  });

  it("does not add gateway headers (incl. traceparent) to the direct fallback attempt", async () => {
    const provider = new BasicTracerProvider();
    const { fetchImpl, attempts } = headerCapturingTransport(503);
    const xfetch = fallbackFetchWith(fetchImpl, provider.getTracer("test"));

    await xfetch("https://gateway.xybrid.ai/openai/v1/chat/completions", { method: "POST" });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.headers.get("traceparent")).not.toBeNull(); // gateway attempt
    expect(attempts[1]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(attempts[1]!.headers.get("traceparent")).toBeNull(); // provider gets the original init
    expect(attempts[1]!.headers.get("x-xybrid-key")).toBeNull();
  });

  it("traceparentFrom serializes a valid context and rejects the invalid one", () => {
    const fakeValid = {
      spanContext: () => ({
        traceId: "abcdefabcdefabcdefabcdefabcdefab",
        spanId: "1234567812345678",
        traceFlags: 1,
      }),
    };
    const fakeInvalid = {
      spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(traceparentFrom(fakeValid as any)).toBe(
      "00-abcdefabcdefabcdefabcdefabcdefab-1234567812345678-01",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(traceparentFrom(fakeInvalid as any)).toBeUndefined();
  });
});
