import { SpanKind, SpanStatusCode, type SpanStatus } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { isAISpan } from "./is-ai-span.ts";
import { isContentAttribute, spanToEvent } from "./span-to-event.ts";

function fakeSpan(over: Partial<ReadableSpan> = {}): ReadableSpan {
  const base = {
    name: "anthropic.messages.create",
    kind: SpanKind.CLIENT,
    spanContext: () => ({ traceId: "trace-1", spanId: "span-1", traceFlags: 1 }),
    startTime: [1000, 0] as [number, number],
    endTime: [1000, 500_000_000] as [number, number],
    duration: [0, 500_000_000] as [number, number],
    status: { code: SpanStatusCode.OK } satisfies SpanStatus,
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-3-5-sonnet-latest",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 240,
    },
    resource: { attributes: { "service.name": "my-app", "xybrid.project_id": "proj-1" } },
  };
  return { ...base, ...over } as unknown as ReadableSpan;
}

describe("isAISpan", () => {
  it("accepts GenAI-annotated spans", () => {
    expect(isAISpan(fakeSpan())).toBe(true);
  });

  it("rejects unrelated spans", () => {
    const plain = fakeSpan({ name: "GET /health", attributes: {} });
    expect(isAISpan(plain)).toBe(false);
  });
});

describe("isContentAttribute", () => {
  it("matches exact keys and dotted children, not lookalike prefixes", () => {
    expect(isContentAttribute("gen_ai.prompt")).toBe(true);
    expect(isContentAttribute("gen_ai.prompt.0.role")).toBe(true);
    expect(isContentAttribute("traceloop.entity.output")).toBe(true);
    expect(isContentAttribute("ai.toolCall.args")).toBe(true);
    expect(isContentAttribute("gen_ai.system")).toBe(false);
    expect(isContentAttribute("gen_ai.usage.input_tokens")).toBe(false);
    expect(isContentAttribute("ai.response.finishReason")).toBe(false);
  });
});

describe("spanToEvent", () => {
  it("maps identity, provider, model, tokens, and timing", () => {
    const event = spanToEvent(fakeSpan());
    expect(event).toMatchObject({
      event_type: "otel.span.completed",
      trace_id: "trace-1",
      span_id: "span-1",
      service_name: "my-app",
      project_id: "proj-1",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      input_tokens: 1200,
      output_tokens: 240,
      total_tokens: 1440,
      duration_ms: 500,
      kind: "CLIENT",
      status_code: "OK",
    });
    expect(event.error).toBeUndefined();
  });

  it("carries the error message on failed spans", () => {
    const event = spanToEvent(
      fakeSpan({ status: { code: SpanStatusCode.ERROR, message: "overloaded" } }),
    );
    expect(event.status_code).toBe("ERROR");
    expect(event.error).toBe("overloaded");
  });

  it("omits token fields when the span has none", () => {
    const event = spanToEvent(fakeSpan({ attributes: { "gen_ai.system": "openai" } }));
    expect(event.input_tokens).toBeUndefined();
    expect(event.output_tokens).toBeUndefined();
    expect(event.total_tokens).toBeUndefined();
  });

  it("prefers an explicit total_tokens attribute over summing", () => {
    const event = spanToEvent(
      fakeSpan({
        attributes: {
          "gen_ai.system": "openai",
          "gen_ai.usage.input_tokens": 10,
          "gen_ai.usage.output_tokens": 20,
          "gen_ai.usage.total_tokens": 99,
        },
      }),
    );
    expect(event.total_tokens).toBe(99);
  });

  it("reads the older llm.* fallback conventions", () => {
    const event = spanToEvent(
      fakeSpan({
        name: "chat",
        attributes: {
          "llm.system": "openai",
          "llm.request.model": "gpt-4o-mini",
          "llm.usage.prompt_tokens": 5,
          "llm.usage.completion_tokens": 7,
        },
      }),
    );
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("gpt-4o-mini");
    expect(event.input_tokens).toBe(5);
    expect(event.output_tokens).toBe(7);
    expect(event.total_tokens).toBe(12);
  });

  it("strips content-bearing attributes by default", () => {
    const event = spanToEvent(
      fakeSpan({
        attributes: {
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": "claude-sonnet-5",
          "gen_ai.prompt.0.content": "secret prompt",
          "gen_ai.completion.0.content": "secret answer",
          "traceloop.entity.input": '{"messages":[...]}',
          "ai.prompt.messages": "[...]",
          "ai.response.text": "hello",
        },
      }),
    );
    expect(Object.keys(event.attributes).sort()).toEqual([
      "gen_ai.request.model",
      "gen_ai.system",
    ]);
    expect(event.provider).toBe("anthropic");
    expect(event.model).toBe("claude-sonnet-5");
  });

  it("keeps content attributes when captureContent is true", () => {
    const event = spanToEvent(
      fakeSpan({
        attributes: {
          "gen_ai.system": "anthropic",
          "gen_ai.prompt.0.content": "secret prompt",
        },
      }),
      { captureContent: true },
    );
    expect(event.attributes["gen_ai.prompt.0.content"]).toBe("secret prompt");
  });

  it("reads the OTel 2.x parentSpanContext shape", () => {
    const event = spanToEvent(
      fakeSpan({ parentSpanContext: { spanId: "parent-2x" } } as unknown as Partial<ReadableSpan>),
    );
    expect(event.parent_span_id).toBe("parent-2x");
  });
});
