import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { XybridSpanProcessor } from "./processor.ts";

function fakeSpan(name: string, attributes: Record<string, unknown>): ReadableSpan {
  return {
    name,
    kind: SpanKind.CLIENT,
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
    startTime: [1000, 0],
    endTime: [1000, 0],
    duration: [0, 0],
    status: { code: SpanStatusCode.OK },
    attributes,
    resource: { attributes: {} },
  } as unknown as ReadableSpan;
}

/** A `vi.fn` typed off the real `fetch` signature so `mock.calls` is well-typed. */
function mockFetch() {
  return vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(null, { status: 200 }),
  );
}

describe("XybridSpanProcessor", () => {
  it("forwards only AI spans and drops the rest", async () => {
    const fetchImpl = mockFetch();
    const processor = new XybridSpanProcessor({
      apiKey: "xyk_test",
      endpoint: "https://otel.test/v1/spans",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    processor.onEnd(fakeSpan("anthropic.messages.create", { "gen_ai.system": "anthropic" }));
    processor.onEnd(fakeSpan("GET /health", {})); // not an AI span → dropped
    await processor.forceFlush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].provider).toBe("anthropic");

    await processor.shutdown();
  });

  it("sends nothing when no AI spans are seen", async () => {
    const fetchImpl = mockFetch();
    const processor = new XybridSpanProcessor({
      apiKey: "xyk_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    processor.onEnd(fakeSpan("GET /health", {}));
    await processor.forceFlush();

    expect(fetchImpl).not.toHaveBeenCalled();
    await processor.shutdown();
  });
});
