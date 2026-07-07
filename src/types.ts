/** Configuration shared by the exporter and span processor. */
export interface XybridElixirConfig {
  /** Xybrid API key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /**
   * Full span-ingest URL. Defaults to the hosted endpoint.
   * @default "https://otel.xybrid.ai/v1/spans"
   */
  endpoint?: string;
  /**
   * Custom `fetch` implementation. Defaults to the global `fetch` (Node 18+).
   * Pass one explicitly on older runtimes or to inject a mock in tests.
   */
  fetchImpl?: typeof fetch;
}

/**
 * The span event shipped to Xybrid's `/v1/spans` ingest endpoint. Mirrors the
 * `XybridOTelSpanEvent` contract in `docs/otel-modes-implementation-plan.md`.
 * `customer_id` is resolved server-side from the API key and is never sent here.
 */
export interface XybridOTelSpanEvent {
  event_type: "otel.span.completed";
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service_name?: string;
  project_id?: string;
  name: string;
  kind: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  attributes: Record<string, unknown>;
  provider?: string;
  operation?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  status_code?: string;
  error?: string;
}
