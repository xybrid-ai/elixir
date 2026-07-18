import { isSpanContextValid, SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";

import type { CircuitPolicy, FallbackPolicy, ResolvedFallbackPolicy } from "./types.ts";

/** Fill in defaults for a partial {@link FallbackPolicy}. */
export function resolveFallback(policy?: FallbackPolicy): ResolvedFallbackPolicy {
  return {
    timeoutMs: policy?.timeoutMs ?? 10_000,
    retryStatuses: policy?.retryStatuses ?? [502, 503, 504],
    circuit: {
      failureThreshold: policy?.circuit?.failureThreshold ?? 5,
      windowMs: policy?.circuit?.windowMs ?? 30_000,
      cooldownMs: policy?.circuit?.cooldownMs ?? 15_000,
    },
  };
}

/**
 * Rolling-window circuit breaker. Once `failureThreshold` failures occur within
 * `windowMs`, it opens for `cooldownMs` so a struggling gateway isn't re-probed
 * on every single call.
 */
class CircuitBreaker {
  private failures: number[] = [];
  private openUntil = 0;

  constructor(private readonly policy: CircuitPolicy) {}

  isOpen(now: number): boolean {
    return now < this.openUntil;
  }

  recordSuccess(): void {
    this.failures = [];
  }

  recordFailure(now: number): void {
    this.failures = this.failures.filter((t) => now - t <= this.policy.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.policy.failureThreshold) {
      this.openUntil = now + this.policy.cooldownMs;
      this.failures = [];
    }
  }
}

export interface FallbackFetchOptions {
  /** The transport to make the actual request with (the client's original `fetch`). */
  fetchImpl: typeof fetch;
  /** Routed prefix now on the client, e.g. `https://gateway.xybrid.ai/openai/v1`. */
  gatewayPrefix: string;
  /** Original provider prefix to fall back to, e.g. `https://api.openai.com/v1`. */
  upstreamPrefix: string;
  /** `gen_ai.system` value for the correlation span, e.g. `"openai"`. */
  system: string;
  /** Xybrid API key, forwarded to the gateway as `x-xybrid-key`. */
  apiKey: string;
  policy: ResolvedFallbackPolicy;
  tracer?: Tracer;
}

/**
 * Builds a `fetch` that tries the Xybrid gateway first and falls back to the
 * provider's own base URL when the gateway is unhealthy. Emits an always-on
 * client-side span (latency + `xybrid.routed` / `xybrid.fallback` flags) so
 * telemetry survives even when the request bypasses the gateway.
 *
 * NOTE (spike): assumes the SDK calls `fetch(urlString, init)` — the shape the
 * OpenAI Node SDK uses. `Request`-object inputs would need extra handling.
 */
export function createFallbackFetch(opts: FallbackFetchOptions): typeof fetch {
  const breaker = new CircuitBreaker(opts.policy.circuit);
  const tracer = opts.tracer ?? trace.getTracer("@xybrid/elixir");

  return async function xybridFetch(input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const model = peekModel(init?.body);

    return tracer.startActiveSpan(`xybrid ${opts.system}`, async (span) => {
      span.setAttribute("gen_ai.system", opts.system);
      if (model) span.setAttribute("gen_ai.request.model", model);

      const goDirect = breaker.isOpen(Date.now());
      try {
        if (!goDirect) {
          try {
            const res = await fetchWithTimeout(
              opts.fetchImpl,
              url,
              withGatewayHeaders(init, opts, span),
              opts.policy.timeoutMs,
            );
            if (!opts.policy.retryStatuses.includes(res.status)) {
              breaker.recordSuccess();
              finish(span, res.status, { routed: true, fallback: false, circuitOpen: false });
              return res;
            }
            breaker.recordFailure(Date.now()); // retryable status → fall through
          } catch {
            breaker.recordFailure(Date.now()); // timeout / connection error → fall through
          }
        }

        // Fallback: hit the provider directly, without the gateway headers.
        const directUrl = url.startsWith(opts.gatewayPrefix)
          ? opts.upstreamPrefix + url.slice(opts.gatewayPrefix.length)
          : url;
        const res = await opts.fetchImpl(directUrl, init);
        finish(span, res.status, { routed: !goDirect, fallback: true, circuitOpen: goDirect });
        return res;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw err;
      }
    });
  };
}

function finish(
  span: ReturnType<Tracer["startSpan"]>,
  status: number,
  flags: { routed: boolean; fallback: boolean; circuitOpen: boolean },
): void {
  span.setAttribute("http.response.status_code", status);
  span.setAttribute("xybrid.routed", flags.routed);
  span.setAttribute("xybrid.fallback", flags.fallback);
  span.setAttribute("xybrid.circuit_open", flags.circuitOpen);
  span.end();
}

/** Clone `init` and add the gateway routing headers for the proxied attempt. */
function withGatewayHeaders(
  init: RequestInit | undefined,
  opts: FallbackFetchOptions,
  span: Span,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("x-xybrid-key", opts.apiKey);
  headers.set("x-xybrid-upstream", opts.upstreamPrefix);
  // Mode C join key: the gateway parses `traceparent` and lands the caller's
  // span id on its metering event, so the exported correlation span and the
  // gateway's ai_generations row share (trace_id, span_id). Without this
  // header a brewed call produces two rows with no join key at all. Respect a
  // header the app's own instrumentation already set.
  if (!headers.has("traceparent")) {
    const traceparent = traceparentFrom(span);
    if (traceparent) headers.set("traceparent", traceparent);
  }
  return { ...init, headers };
}

/**
 * Serialize a span's context as a W3C `traceparent` (`00-<trace>-<span>-<flags>`).
 * Returns `undefined` when no real tracer provider is registered (the no-op
 * tracer yields an all-zero, invalid context) — in that case no span is
 * exported either, so there is nothing to join; the gateway mints its own
 * trace identity instead.
 */
export function traceparentFrom(span: Span): string | undefined {
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return undefined;
  const flags = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

/**
 * Run a request with a timeout. Overrides any caller-supplied `signal` for the
 * gateway attempt — acceptable here since the fallback path re-issues with the
 * original `init`.
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("xybrid gateway timeout")), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort peek of the `model` field from a JSON request body, for the span. */
function peekModel(body: RequestInit["body"]): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}
