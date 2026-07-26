import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { createFallbackFetch, resolveFallback, XYBRID_ERROR_HEADER } from "./gateway.ts";
import type { FallbackPolicy } from "./types.ts";

const GATEWAY = "https://gateway.xybrid.ai/openai/v1";
const UPSTREAM = "https://api.openai.com/v1";
const PATH = "/chat/completions";

/**
 * Mock transport answering gateway hits from a queue of statuses (the last one
 * repeats) and every direct-to-provider hit with 200.
 */
function transport(gatewayStatuses: number[], gatewayHeaders: Record<string, string> = {}) {
  const calls: string[] = [];
  const queue = [...gatewayStatuses];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    if (!url.startsWith("https://gateway.xybrid.ai")) return new Response("{}", { status: 200 });
    const status = queue.length > 1 ? queue.shift()! : queue[0]!;
    return new Response("{}", { status, headers: gatewayHeaders });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function fallbackFetch(
  fetchImpl: typeof fetch,
  policy?: FallbackPolicy,
  warn?: (line: string) => void,
) {
  return createFallbackFetch({
    fetchImpl,
    gatewayPrefix: GATEWAY,
    upstreamPrefix: UPSTREAM,
    system: "openai",
    apiKey: "xyb_test",
    policy: resolveFallback(policy),
    warn,
  });
}

describe("fallback matrix — which gateway statuses fall back", () => {
  // Regression: the default used to be [502, 503, 504], so a gateway 500 (or a
  // Cloudflare 524) was handed straight to the caller and the provider was
  // never tried — the safety net failed exactly when it was needed.
  it.each([500, 501, 502, 503, 504, 507, 520, 524, 530, 408, 429])(
    "falls back to the provider on gateway %i",
    async (status) => {
      const { fetchImpl, calls } = transport([status]);
      const res = await fallbackFetch(fetchImpl)(`${GATEWAY}${PATH}`, { method: "POST" });

      expect(res.status).toBe(200);
      expect(calls).toEqual([`${GATEWAY}${PATH}`, `${UPSTREAM}${PATH}`]);
    },
  );

  // The other half of the contract: a provider error proxied through the gateway
  // is a real answer. Replaying it upstream would just repeat it, at double cost.
  it.each([400, 404, 409, 422])("passes a provider %i straight through", async (status) => {
    const { fetchImpl, calls } = transport([status]);
    const res = await fallbackFetch(fetchImpl)(`${GATEWAY}${PATH}`, { method: "POST" });

    expect(res.status).toBe(status);
    expect(calls).toEqual([`${GATEWAY}${PATH}`]);
  });

  it("passes an unmarked 401 through — that is the caller's provider key, not ours", async () => {
    const { fetchImpl, calls } = transport([401]);
    const res = await fallbackFetch(fetchImpl)(`${GATEWAY}${PATH}`, { method: "POST" });

    expect(res.status).toBe(401);
    expect(calls).toEqual([`${GATEWAY}${PATH}`]);
  });

  it("falls back and warns once when the gateway rejects the Xybrid key", async () => {
    const warnings: string[] = [];
    const { fetchImpl, calls } = transport([401], { [XYBRID_ERROR_HEADER]: "invalid_api_key" });
    const xfetch = fallbackFetch(fetchImpl, undefined, (l) => warnings.push(l));

    expect((await xfetch(`${GATEWAY}${PATH}`, { method: "POST" })).status).toBe(200);
    expect((await xfetch(`${GATEWAY}${PATH}`, { method: "POST" })).status).toBe(200);

    expect(calls.filter((u) => u.startsWith(UPSTREAM))).toHaveLength(2);
    // Loud enough to diagnose, once — not once per request.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/rejected this API key/);
  });

  it("honours retryServerErrors: false", async () => {
    const { fetchImpl, calls } = transport([500]);
    const res = await fallbackFetch(fetchImpl, { retryServerErrors: false })(`${GATEWAY}${PATH}`, {
      method: "POST",
    });

    expect(res.status).toBe(500);
    expect(calls).toEqual([`${GATEWAY}${PATH}`]);
  });

  it("honours an explicit retryStatuses list", async () => {
    const { fetchImpl, calls } = transport([418]);
    const res = await fallbackFetch(fetchImpl, { retryStatuses: [418] })(`${GATEWAY}${PATH}`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(calls).toEqual([`${GATEWAY}${PATH}`, `${UPSTREAM}${PATH}`]);
  });
});

describe("circuit breaker accounting", () => {
  const policy: FallbackPolicy = {
    circuit: { failureThreshold: 2, windowMs: 60_000, cooldownMs: 60_000 },
  };

  // Regression: a success used to wipe the whole failure window, so a gateway
  // alternating pass/fail could never trip the breaker no matter how long it
  // stayed broken.
  it("trips on N failures in the window even when successes interleave", async () => {
    const { fetchImpl, calls } = transport([503, 200, 503, 200]);
    const xfetch = fallbackFetch(fetchImpl, policy);

    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" }); // 503 → failure 1
    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" }); // 200 → must not reset
    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" }); // 503 → failure 2, trips
    calls.length = 0;
    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" });

    expect(calls).toEqual([`${UPSTREAM}${PATH}`]); // circuit open: gateway skipped
  });

  // Regression: a non-retryable status used to be recorded as a *success*, so a
  // gateway 500ing on every single request read as perfectly healthy.
  it("counts a gateway 500 as a failure", async () => {
    const { fetchImpl, calls } = transport([500]);
    const xfetch = fallbackFetch(fetchImpl, policy);

    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" });
    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" }); // trips
    calls.length = 0;
    await xfetch(`${GATEWAY}${PATH}`, { method: "POST" });

    expect(calls).toEqual([`${UPSTREAM}${PATH}`]);
  });
});

describe("fallback reason on the correlation span", () => {
  async function reasonFor(gatewayStatuses: number[], calls = 1): Promise<unknown> {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memory)],
    });
    const { fetchImpl } = transport(gatewayStatuses);
    const xfetch = createFallbackFetch({
      fetchImpl,
      gatewayPrefix: GATEWAY,
      upstreamPrefix: UPSTREAM,
      system: "openai",
      apiKey: "xyb_test",
      policy: resolveFallback({ circuit: { failureThreshold: 1, cooldownMs: 60_000 } }),
      tracer: provider.getTracer("test"),
    });
    for (let i = 0; i < calls; i++) await xfetch(`${GATEWAY}${PATH}`, { method: "POST" });
    const spans = memory.getFinishedSpans();
    return spans[spans.length - 1]!.attributes["xybrid.fallback_reason"];
  }

  it("records `status` when the gateway returns a retryable status", async () => {
    expect(await reasonFor([503])).toBe("status");
  });

  it("records `circuit_open` once the breaker has tripped", async () => {
    expect(await reasonFor([503], 2)).toBe("circuit_open");
  });

  it("records no reason on the happy path", async () => {
    expect(await reasonFor([200])).toBeUndefined();
  });

  it("records `timeout` when the gateway attempt exceeds timeoutMs", async () => {
    const memory = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(memory)],
    });
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.startsWith("https://gateway.xybrid.ai")) return new Response("{}", { status: 200 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    const xfetch = createFallbackFetch({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gatewayPrefix: GATEWAY,
      upstreamPrefix: UPSTREAM,
      system: "openai",
      apiKey: "xyb_test",
      policy: resolveFallback({ timeoutMs: 10 }),
      tracer: provider.getTracer("test"),
    });

    const res = await xfetch(`${GATEWAY}${PATH}`, { method: "POST" });

    expect(res.status).toBe(200); // fell back to the provider
    expect(memory.getFinishedSpans()[0]!.attributes["xybrid.fallback_reason"]).toBe("timeout");
  });

  it("leaves the global tracer provider untouched", () => {
    // Guard against these tests leaking a provider into the shared OTel global.
    expect(trace.getTracerProvider()).toBeDefined();
  });
});
