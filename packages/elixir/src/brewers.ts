import { createFallbackFetch } from "./gateway.ts";
import type { Brewer } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Structural view of an OpenAI Node SDK v4/v5 client — no hard dep on `openai`. */
interface OpenAILike {
  baseURL: string;
  fetch?: typeof fetch;
  chat: { completions: unknown };
}

/**
 * Routes an OpenAI client's traffic through the Xybrid gateway with a fallback
 * to `api.openai.com`. Reroutes by mutating the constructed instance's
 * `baseURL` + `fetch` — version-aware by design; guarded by {@link supports}.
 */
export const openaiBrewer: Brewer<OpenAILike> = {
  name: "openai",

  handles(client): client is OpenAILike {
    return (
      isObject(client) &&
      typeof client["baseURL"] === "string" &&
      isObject(client["chat"]) &&
      isObject((client["chat"] as Record<string, unknown>)["completions"])
    );
  },

  supports(client): boolean {
    // v4/v5 expose a mutable `baseURL` and honor an instance-level `fetch`.
    return typeof client.baseURL === "string";
  },

  route(client, ctx): void {
    const upstreamPrefix = client.baseURL.replace(/\/+$/, ""); // e.g. https://api.openai.com/v1
    const gatewayPrefix = `${ctx.gateway.replace(/\/+$/, "")}/openai/v1`;
    const originalFetch = client.fetch ?? globalThis.fetch;

    client.fetch = createFallbackFetch({
      fetchImpl: originalFetch,
      gatewayPrefix,
      upstreamPrefix,
      system: "openai",
      apiKey: ctx.apiKey,
      policy: ctx.fallback,
    });
    client.baseURL = gatewayPrefix;
  },

  instrument(_client): void {
    // Rich gen-ai spans (model, tokens, messages) come from
    // `@traceloop/instrumentation-openai`. In this spike the always-on
    // correlation span is emitted by `createFallbackFetch`.
    // TODO: enable + dedupe the traceloop OpenAI instrumentation here.
  },
};

// Later providers register the same way: registerBrewer(anthropicBrewer), etc.
const registry: Brewer[] = [openaiBrewer];

/** Register a provider brewer. Newest wins on `handles` ties. */
export function registerBrewer(brewer: Brewer): void {
  registry.unshift(brewer);
}

/** Find the first registered brewer that handles `client`. */
export function findBrewer(client: unknown): Brewer | undefined {
  return registry.find((brewer) => brewer.handles(client));
}
