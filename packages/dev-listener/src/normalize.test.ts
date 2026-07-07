import { describe, expect, it } from "vitest";

import {
  inferInputTokens,
  inferModel,
  inferOperation,
  inferOutputTokens,
  inferProvider,
  isGenAISpan,
  normalizeSpanEvent,
  sanitizeAttributes,
} from "./normalize.ts";
import type { XybridOTelSpanEvent } from "./types.ts";

function event(over: Partial<XybridOTelSpanEvent> = {}): XybridOTelSpanEvent {
  return {
    event_type: "otel.span.completed",
    trace_id: "8f3c1a2b9d0e4f56",
    span_id: "91ab23cd45ef",
    name: "anthropic.messages.create",
    ...over,
  };
}

describe("inferProvider", () => {
  it("prefers the explicit provider field", () => {
    expect(inferProvider(event({ provider: "anthropic" }))).toBe("anthropic");
  });

  it("falls back to gen_ai.system, then llm.system", () => {
    expect(inferProvider(event({ name: "x", attributes: { "gen_ai.system": "openai" } }))).toBe("openai");
    expect(inferProvider(event({ name: "x", attributes: { "llm.system": "cohere" } }))).toBe("cohere");
  });

  it("infers from the span name, else unknown", () => {
    expect(inferProvider(event({ name: "anthropic.messages.create" }))).toBe("anthropic");
    expect(inferProvider(event({ name: "openai.chat.completions" }))).toBe("openai");
    expect(inferProvider(event({ name: "vercel.ai.generateText" }))).toBe("vercel_ai");
    expect(inferProvider(event({ name: "GET /health" }))).toBe("unknown");
  });
});

describe("inferModel", () => {
  it("walks the fallback chain and defaults to empty string", () => {
    expect(inferModel(event({ model: "m1" }))).toBe("m1");
    expect(inferModel(event({ attributes: { "gen_ai.request.model": "m2" } }))).toBe("m2");
    expect(inferModel(event({ attributes: { "gen_ai.response.model": "m3" } }))).toBe("m3");
    expect(inferModel(event({ attributes: { "llm.request.model": "m4" } }))).toBe("m4");
    expect(inferModel(event({ attributes: { "llm.response.model": "m5" } }))).toBe("m5");
    expect(inferModel(event())).toBe("");
  });
});

describe("inferOperation", () => {
  it("prefers explicit fields", () => {
    expect(inferOperation(event({ operation: "chat" }))).toBe("chat");
    expect(inferOperation(event({ attributes: { "gen_ai.operation.name": "text_completion" } }))).toBe(
      "text_completion",
    );
  });

  it("infers from the span name", () => {
    expect(inferOperation(event({ name: "openai.embeddings.create" }))).toBe("embedding");
    expect(inferOperation(event({ name: "openai.chat.completions" }))).toBe("llm.chat");
    expect(inferOperation(event({ name: "text.completion" }))).toBe("llm.chat");
  });

  it("defaults to llm.chat for known chat providers, else unknown", () => {
    expect(inferOperation(event({ name: "x", provider: "anthropic" }))).toBe("llm.chat");
    expect(inferOperation(event({ name: "x" }))).toBe("unknown");
  });
});

describe("token inference", () => {
  it("prefers top-level fields", () => {
    const e = event({ input_tokens: 10, output_tokens: 20 });
    expect(inferInputTokens(e)).toBe(10);
    expect(inferOutputTokens(e)).toBe(20);
  });

  it("reads the attribute fallback chains and coerces strings", () => {
    const e = event({
      attributes: { "llm.usage.prompt_tokens": "5", "usage.completion_tokens": 7 },
    });
    expect(inferInputTokens(e)).toBe(5);
    expect(inferOutputTokens(e)).toBe(7);
  });

  it("defaults to 0 on missing or garbage values", () => {
    const e = event({ attributes: { "gen_ai.usage.input_tokens": "NaN-ish" } });
    expect(inferInputTokens(e)).toBe(0);
    expect(inferOutputTokens(event())).toBe(0);
  });
});

describe("isGenAISpan", () => {
  it("accepts gen_ai/llm/ai attributes, explicit provider, or name hints", () => {
    expect(isGenAISpan(event({ name: "x", attributes: { "gen_ai.system": "openai" } }))).toBe(true);
    expect(isGenAISpan(event({ name: "x", provider: "anthropic" }))).toBe(true);
    expect(isGenAISpan(event({ name: "anthropic.messages.create" }))).toBe(true);
    expect(isGenAISpan(event({ name: "GET /health" }))).toBe(false);
  });
});

describe("sanitizeAttributes", () => {
  const attrs = {
    "gen_ai.system": "anthropic",
    "gen_ai.prompt.0.content": "secret prompt",
    "traceloop.entity.output": "secret answer",
    "ai.response.text": "hello",
    "gen_ai.usage.input_tokens": 1200,
    "gen_ai.usage.output_tokens": 240,
  };

  it("replaces content values with [redacted] but keeps the keys", () => {
    const clean = sanitizeAttributes(attrs, { captureContent: false });
    expect(clean["gen_ai.prompt.0.content"]).toBe("[redacted]");
    expect(clean["traceloop.entity.output"]).toBe("[redacted]");
    expect(clean["ai.response.text"]).toBe("[redacted]");
    expect(clean["gen_ai.system"]).toBe("anthropic");
  });

  it("never redacts token/usage counts despite input/output in the key", () => {
    const clean = sanitizeAttributes(attrs, { captureContent: false });
    expect(clean["gen_ai.usage.input_tokens"]).toBe(1200);
    expect(clean["gen_ai.usage.output_tokens"]).toBe(240);
  });

  it("passes everything through with captureContent", () => {
    expect(sanitizeAttributes(attrs, { captureContent: true })).toEqual(attrs);
  });
});

describe("normalizeSpanEvent", () => {
  it("normalizes a typical anthropic span", () => {
    const n = normalizeSpanEvent(
      event({
        duration_ms: 920,
        attributes: {
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": "claude-3-5-sonnet-latest",
          "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.output_tokens": 240,
          "gen_ai.prompt.0.content": "secret",
        },
      }),
      { captureContent: false, receivedAt: "2026-07-07T14:22:01.000Z" },
    );
    expect(n).toMatchObject({
      event_type: "otel.span.completed",
      received_at: "2026-07-07T14:22:01.000Z",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      operation: "llm.chat",
      input_tokens: 1200,
      output_tokens: 240,
      total_tokens: 1440,
      duration_ms: 920,
      status: "success",
    });
    expect(n.attributes["gen_ai.prompt.0.content"]).toBe("[redacted]");
    expect(n.raw.attributes?.["gen_ai.prompt.0.content"]).toBe("[redacted]");
  });

  it("marks error spans and carries the message", () => {
    const n = normalizeSpanEvent(event({ status_code: "ERROR", error: "RateLimitError: slow down" }), {
      captureContent: false,
    });
    expect(n.status).toBe("error");
    expect(n.error).toBe("RateLimitError: slow down");
  });

  it("stamps received_at when not provided", () => {
    const n = normalizeSpanEvent(event(), { captureContent: false });
    expect(Number.isNaN(Date.parse(n.received_at))).toBe(false);
  });
});
