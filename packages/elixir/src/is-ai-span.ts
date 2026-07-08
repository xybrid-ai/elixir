import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * Whether a completed span represents an AI / LLM operation worth sending to
 * Xybrid. Recognizes OTel GenAI semantic conventions, the older `llm.*`
 * conventions, Traceloop's marker, and provider names in the span name.
 */
export function isAISpan(span: ReadableSpan): boolean {
  const attrs = span.attributes;
  return Boolean(
    attrs["gen_ai.system"] ||
      attrs["gen_ai.operation.name"] ||
      attrs["llm.system"] ||
      attrs["traceloop.span.kind"] ||
      span.name.includes("openai") ||
      span.name.includes("anthropic"),
  );
}
