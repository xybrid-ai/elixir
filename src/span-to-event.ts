import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { hrTimeToMilliseconds } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import type { XybridOTelSpanEvent } from "./types.ts";

/**
 * Attribute keys/prefixes that carry prompt, response, tool, or message content —
 * OTel GenAI semconv, the older `llm.*` conventions, Traceloop entity payloads,
 * and Vercel AI SDK telemetry.
 */
const CONTENT_ATTRIBUTE_PREFIXES = [
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "llm.prompts",
  "llm.completions",
  "traceloop.entity.input",
  "traceloop.entity.output",
  "ai.prompt",
  "ai.toolCall",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.result.text",
  "ai.result.object",
  "ai.result.toolCalls",
];

/** Whether `key` is a content-bearing span attribute (see the prefix list above). */
export function isContentAttribute(key: string): boolean {
  return CONTENT_ATTRIBUTE_PREFIXES.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}.`),
  );
}

export interface SpanToEventOptions {
  /**
   * Forward content-bearing attributes (prompts, completions, tool input/output,
   * messages) with the event.
   * @default false
   */
  captureContent?: boolean;
}

/** First defined attribute among `keys`, coerced to string. */
function attrString(span: ReadableSpan, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = span.attributes[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

/** First defined attribute among `keys`, coerced to a finite number. */
function attrNumber(span: ReadableSpan, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = span.attributes[key];
    if (value === undefined || value === null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * The parent span id, tolerant of both the 1.x (`parentSpanId`) and 2.x
 * (`parentSpanContext.spanId`) shapes of `ReadableSpan`.
 */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanId?: string;
    parentSpanContext?: { spanId?: string };
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

function resourceAttr(span: ReadableSpan, key: string): string | undefined {
  const value = span.resource?.attributes?.[key];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Convert an OTel `ReadableSpan` into the Xybrid span-ingest event shape.
 * Content-bearing attributes are stripped unless `options.captureContent` is true.
 */
export function spanToEvent(
  span: ReadableSpan,
  options: SpanToEventOptions = {},
): XybridOTelSpanEvent {
  const ctx = span.spanContext();
  const attributes = options.captureContent
    ? { ...span.attributes }
    : Object.fromEntries(
        Object.entries(span.attributes).filter(([key]) => !isContentAttribute(key)),
      );
  const inputTokens = attrNumber(span, "gen_ai.usage.input_tokens", "llm.usage.prompt_tokens");
  const outputTokens = attrNumber(span, "gen_ai.usage.output_tokens", "llm.usage.completion_tokens");
  const totalTokens =
    attrNumber(span, "gen_ai.usage.total_tokens") ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  const isError = span.status.code === SpanStatusCode.ERROR;

  return {
    event_type: "otel.span.completed",
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    parent_span_id: parentSpanId(span),
    service_name: resourceAttr(span, "service.name"),
    project_id: resourceAttr(span, "xybrid.project_id"),
    name: span.name,
    kind: SpanKind[span.kind],
    started_at: new Date(hrTimeToMilliseconds(span.startTime)).toISOString(),
    ended_at: new Date(hrTimeToMilliseconds(span.endTime)).toISOString(),
    duration_ms: hrTimeToMilliseconds(span.duration),
    attributes,
    provider: attrString(span, "gen_ai.system", "llm.system"),
    operation: attrString(span, "gen_ai.operation.name"),
    model: attrString(span, "gen_ai.request.model", "gen_ai.response.model", "llm.request.model"),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    status_code: SpanStatusCode[span.status.code],
    error: isError ? span.status.message : undefined,
  };
}
