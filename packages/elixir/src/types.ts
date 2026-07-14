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
  /**
   * Forward content-bearing span attributes (prompts, completions, tool
   * input/output, messages) to Xybrid. Off by default so instrumentations that
   * record content don't ship it unintentionally; metadata (provider, model,
   * tokens, timing) is always sent.
   * @default false
   */
  captureContent?: boolean;
}

/** Circuit-breaker tuning for the {@link FallbackPolicy}. */
export interface CircuitPolicy {
  /** Failures within `windowMs` that trip the breaker open. */
  failureThreshold: number;
  /** Rolling window over which failures are counted. */
  windowMs: number;
  /** How long the breaker stays open (routes direct to upstream) once tripped. */
  cooldownMs: number;
}

/**
 * When `brew` routes traffic through the Xybrid gateway, this controls the
 * safety net: what counts as "gateway struggling" and how aggressively to fall
 * back to the provider's own base URL.
 */
export interface FallbackPolicy {
  /** Abort a gateway attempt after this long and fall back. @default 10_000 */
  timeoutMs?: number;
  /** HTTP statuses from the gateway that trigger fallback. @default [502, 503, 504] */
  retryStatuses?: number[];
  /** Circuit breaker so a down gateway isn't re-probed on every call. */
  circuit?: Partial<CircuitPolicy>;
}

/** {@link FallbackPolicy} with every field resolved to a concrete value. */
export interface ResolvedFallbackPolicy {
  timeoutMs: number;
  retryStatuses: number[];
  circuit: CircuitPolicy;
}

/** Options for {@link init}. Extends the ingest config with gateway routing. */
export interface ElixirInitOptions extends XybridElixirConfig {
  /** Xybrid project id — attached to spans as `xybrid.project_id`. */
  projectId?: string;
  /** Reported as `service.name`. */
  serviceName?: string;
  /** OTel instrumentations to enable (e.g. `@traceloop/instrumentation-anthropic`). */
  // biome-ignore lint: kept loose to avoid a hard dep on @opentelemetry/instrumentation types here
  instrumentations?: unknown[];
  /**
   * Base URL of the Xybrid LLM gateway that `brew` routes clients through.
   * Distinct from `endpoint` (the span-ingest URL).
   * @default "https://gateway.xybrid.ai"
   */
  gateway?: string;
  /** Safety-net policy for gateway → provider fallback. */
  fallback?: FallbackPolicy;
  /**
   * When a brewed client's version can't be safely rerouted: `false` (default)
   * warns and leaves it on its original base URL; `true` throws instead.
   * @default false
   */
  strict?: boolean;
}

/** Per-call options for {@link Elixir.brew}. */
export interface BrewOptions {
  /**
   * Ensure OTel instrumentation is active for this client so a client-side span
   * is emitted regardless of gateway vs fallback routing. @default true
   */
  instrument?: boolean;
}

/** Resolved context handed to every {@link Brewer}. */
export interface BrewContext {
  gateway: string;
  apiKey: string;
  projectId?: string;
  fallback: ResolvedFallbackPolicy;
  strict: boolean;
}

/**
 * Teaches `brew` how to route + instrument one provider's client. Registering a
 * new provider (Anthropic, OpenRouter, …) is a matter of adding a `Brewer`.
 */
export interface Brewer<T = unknown> {
  /** Provider slug, e.g. `"openai"`. */
  name: string;
  /** Whether this brewer handles the given client instance. */
  handles(client: unknown): client is T;
  /** Whether this client's shape/version can be safely rerouted (transport swap). */
  supports(client: T): boolean;
  /** Mutate the client's transport to route through the gateway with fallback. */
  route(client: T, ctx: BrewContext): void;
  /** Ensure this provider's OTel instrumentation is active (deduped by `init`). */
  instrument?(client: T): void;
}

/** Handle returned by {@link init}. Build first, then `start()` / `brew()`. */
export interface Elixir {
  /** Start OTel auto-instrumentation. Idempotent. */
  start(): void;
  /** Route + instrument a provider client. Returns the same (mutated) client. */
  brew<T>(client: T, opts?: BrewOptions): T;
  /** Flush and stop the underlying NodeSDK. */
  shutdown(): Promise<void>;
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
