import type { NormalizedSpanEvent, XybridOTelSpanEvent } from "./types.ts";

function attr(event: XybridOTelSpanEvent, key: string): unknown {
  return event.attributes?.[key];
}

/** First defined value among `values`, coerced to a non-empty string. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const s = String(value);
    if (s !== "") return s;
  }
  return undefined;
}

/** Coerce to a finite non-negative number, else `undefined`. */
function toCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Provider: explicit field, `gen_ai.system`/`llm.system`, then span-name hints. */
export function inferProvider(event: XybridOTelSpanEvent): string {
  const explicit = firstString(event.provider, attr(event, "gen_ai.system"), attr(event, "llm.system"));
  if (explicit) return explicit;
  const name = (event.name ?? "").toLowerCase();
  if (name.includes("anthropic")) return "anthropic";
  if (name.includes("openai")) return "openai";
  if (name.includes("vercel")) return "vercel_ai";
  return "unknown";
}

/** Model: explicit field, then GenAI/llm request/response model attributes. */
export function inferModel(event: XybridOTelSpanEvent): string {
  return (
    firstString(
      event.model,
      attr(event, "gen_ai.request.model"),
      attr(event, "gen_ai.response.model"),
      attr(event, "llm.request.model"),
      attr(event, "llm.response.model"),
    ) ?? ""
  );
}

/** Operation: explicit field, `gen_ai.operation.name`, then span-name/provider hints. */
export function inferOperation(event: XybridOTelSpanEvent): string {
  const explicit = firstString(event.operation, attr(event, "gen_ai.operation.name"));
  if (explicit) return explicit;
  const name = (event.name ?? "").toLowerCase();
  if (name.includes("embedding")) return "embedding";
  if (name.includes("chat") || name.includes("completion")) return "llm.chat";
  const provider = inferProvider(event);
  if (provider === "openai" || provider === "anthropic") return "llm.chat";
  return "unknown";
}

export function inferInputTokens(event: XybridOTelSpanEvent): number {
  return (
    toCount(event.input_tokens) ??
    toCount(attr(event, "gen_ai.usage.input_tokens")) ??
    toCount(attr(event, "gen_ai.usage.prompt_tokens")) ??
    toCount(attr(event, "llm.usage.prompt_tokens")) ??
    toCount(attr(event, "usage.prompt_tokens")) ??
    0
  );
}

export function inferOutputTokens(event: XybridOTelSpanEvent): number {
  return (
    toCount(event.output_tokens) ??
    toCount(attr(event, "gen_ai.usage.output_tokens")) ??
    toCount(attr(event, "gen_ai.usage.completion_tokens")) ??
    toCount(attr(event, "llm.usage.completion_tokens")) ??
    toCount(attr(event, "usage.completion_tokens")) ??
    0
  );
}

/** Whether the event looks like a GenAI/LLM span at all. */
export function isGenAISpan(event: XybridOTelSpanEvent): boolean {
  if (event.provider) return true;
  const keys = Object.keys(event.attributes ?? {});
  if (keys.some((k) => k.startsWith("gen_ai.") || k.startsWith("llm.") || k.startsWith("ai."))) {
    return true;
  }
  return inferProvider(event) !== "unknown";
}

/**
 * Lowercased substrings that mark an attribute key as content-bearing. Broad on
 * purpose — this is a dev tool, and over-redacting is the safe direction.
 */
const CONTENT_KEY_SUBSTRINGS = [
  "prompt",
  "completion",
  "input",
  "output",
  "messages",
  "message",
  "response",
  "embedding",
  "instructions",
  "tool.arguments",
  "tool.result",
  "tool.call",
  "traceloop.entity.input",
  "traceloop.entity.output",
  "ai.prompt",
  "ai.response",
  "ai.toolcall",
  "ai.result",
];

function isContentKey(key: string): boolean {
  const k = key.toLowerCase();
  // Token/usage counts are metadata, not content, even though their keys
  // contain "input"/"output"/"prompt"/"completion" (e.g. gen_ai.usage.input_tokens).
  if (k.includes("token") || k.includes("usage")) return false;
  return CONTENT_KEY_SUBSTRINGS.some((s) => k.includes(s));
}

/**
 * Replace content-bearing attribute values with `"[redacted]"` unless
 * `captureContent` is set. Keys are kept — seeing that a content field existed
 * is useful.
 */
export function sanitizeAttributes(
  attrs: Record<string, unknown>,
  options: { captureContent: boolean },
): Record<string, unknown> {
  if (options.captureContent) return { ...attrs };
  return Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [key, isContentKey(key) ? "[redacted]" : value]),
  );
}

export interface NormalizeOptions {
  captureContent: boolean;
  /** Override the `received_at` timestamp (tests); defaults to now. */
  receivedAt?: string;
}

/** Normalize a received span event for storage, printing, and NDJSON output. */
export function normalizeSpanEvent(
  event: XybridOTelSpanEvent,
  options: NormalizeOptions,
): NormalizedSpanEvent {
  const inputTokens = inferInputTokens(event);
  const outputTokens = inferOutputTokens(event);
  const totalTokens =
    toCount(event.total_tokens) ??
    toCount(attr(event, "gen_ai.usage.total_tokens")) ??
    toCount(attr(event, "llm.usage.total_tokens")) ??
    inputTokens + outputTokens;
  const attributes = sanitizeAttributes(event.attributes ?? {}, options);
  const isError = event.status_code === "ERROR" || event.error !== undefined;

  return {
    event_type: "otel.span.completed",
    received_at: options.receivedAt ?? new Date().toISOString(),
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: event.parent_span_id,
    service_name: event.service_name,
    name: event.name,
    provider: inferProvider(event),
    operation: inferOperation(event),
    model: inferModel(event),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    duration_ms: toCount(event.duration_ms) ?? 0,
    status: isError ? "error" : "success",
    error: event.error,
    // `raw` gets the same sanitized attributes — storing the unredacted event
    // would defeat the content policy.
    attributes,
    raw: { ...event, attributes },
  };
}
