import { describe, expect, it, vi } from "vitest";

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
    const status = url.includes("gateway.xybrid.ai") ? gatewayStatus : 200;
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
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
