import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { XybridSpanProcessor } from "./processor.ts";

/**
 * A span shaped like the Vercel AI SDK's inner `ai.*.doGenerate` span, emitted
 * when `experimental_telemetry: { isEnabled: true }` is set. It carries both the
 * SDK's own `ai.*` attributes and the OTel `gen_ai.*` semantic conventions — the
 * latter is what the Elixir processor keys off. Locks the assumption that the
 * example's telemetry flows through our pipeline without live API calls.
 */
function aiSdkDoGenerateSpan(): ReadableSpan {
  return {
    name: "ai.generateText.doGenerate",
    kind: SpanKind.CLIENT,
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
    startTime: [1000, 0],
    endTime: [1000, 250_000_000],
    duration: [0, 250_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {
      "operation.name": "ai.generateText.doGenerate",
      "ai.operationId": "ai.generateText.doGenerate",
      "ai.model.provider": "openai.chat",
      "ai.model.id": "gpt-4o-mini",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.response.model": "gpt-4o-mini-2024-07-18",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 8,
    },
    resource: { attributes: { "service.name": "vercel-ai-sdk-example" } },
  } as unknown as ReadableSpan;
}

describe("Vercel AI SDK span shape", () => {
  it("is recognized and mapped by the Elixir processor", async () => {
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response(null, { status: 200 }),
    );
    const processor = new XybridSpanProcessor({
      apiKey: "xyk_test",
      endpoint: "https://otel.test/v1/spans",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    processor.onEnd(aiSdkDoGenerateSpan());
    await processor.forceFlush();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      event_type: "otel.span.completed",
      name: "ai.generateText.doGenerate",
      provider: "openai",
      model: "gpt-4o-mini",
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      service_name: "vercel-ai-sdk-example",
      status_code: "OK",
    });

    await processor.shutdown();
  });
});
