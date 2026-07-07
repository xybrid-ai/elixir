/**
 * The span event emitted by `@xybrid/elixir` to `/v1/spans`. Mirrored locally
 * (rather than imported) so this package has no runtime or publish-time
 * dependency on the SDK. Extra fields are allowed and preserved — never reject
 * unknown keys.
 */
export interface XybridOTelSpanEvent {
  event_type: "otel.span.completed";
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service_name?: string;
  project_id?: string;
  name: string;
  kind?: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  attributes?: Record<string, unknown>;
  provider?: string;
  operation?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  status_code?: string;
  error?: string;
  [extra: string]: unknown;
}

/** What the listener stores, prints, and writes to NDJSON. */
export interface NormalizedSpanEvent {
  event_type: "otel.span.completed";
  received_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service_name?: string;
  name: string;
  provider: string;
  operation: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  status: "success" | "error";
  error?: string;
  attributes: Record<string, unknown>;
  /** The received event; its `attributes` are sanitized under the same content policy. */
  raw: XybridOTelSpanEvent;
}
