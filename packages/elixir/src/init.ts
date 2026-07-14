import type { Instrumentation } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { findBrewer } from "./brewers.ts";
import { resolveFallback } from "./gateway.ts";
import { XybridSpanProcessor } from "./processor.ts";
import type { BrewContext, BrewOptions, Elixir, ElixirInitOptions } from "./types.ts";

const DEFAULT_GATEWAY = "https://gateway.xybrid.ai";

/**
 * Build an {@link Elixir} handle. Unlike {@link startXybridElixir}, this does
 * NOT start OTel — call `.start()` when you're ready. `brew` a provider client
 * to route it through the Xybrid gateway (with fallback) and instrument it.
 *
 * @example
 * const sdk = elixir.init({ apiKey, projectId, gateway, endpoint });
 * const openai = sdk.brew(new OpenAI());
 * sdk.start();
 */
export function init(options: ElixirInitOptions): Elixir {
  if (!options.apiKey) throw new Error("elixir.init: `apiKey` is required");

  const attributes: Record<string, string> = {};
  if (options.serviceName) attributes["service.name"] = options.serviceName;
  if (options.projectId) attributes["xybrid.project_id"] = options.projectId;

  const nodeSdk = new NodeSDK({
    resource: resourceFromAttributes(attributes),
    spanProcessors: [
      new XybridSpanProcessor({
        apiKey: options.apiKey,
        endpoint: options.endpoint,
        captureContent: options.captureContent,
        fetchImpl: options.fetchImpl,
      }),
    ],
    instrumentations: (options.instrumentations as Instrumentation[]) ?? [],
  });

  const ctx: BrewContext = {
    gateway: options.gateway ?? DEFAULT_GATEWAY,
    apiKey: options.apiKey,
    projectId: options.projectId,
    fallback: resolveFallback(options.fallback),
    strict: options.strict ?? false,
  };

  let started = false;

  return {
    start(): void {
      if (started) return;
      nodeSdk.start();
      started = true;
    },

    brew<T>(client: T, opts?: BrewOptions): T {
      const brewer = findBrewer(client);
      if (!brewer) {
        const name = describe(client);
        throw new Error(`elixir.brew: no brewer registered for ${name}`);
      }

      if (brewer.supports(client)) {
        brewer.route(client, ctx);
      } else {
        const message =
          `elixir.brew: ${brewer.name} client version is not supported for routing; ` +
          `leaving it on its original base URL (set { strict: true } to throw instead)`;
        if (ctx.strict) throw new Error(message);
        console.warn(message);
      }

      if (opts?.instrument !== false) brewer.instrument?.(client);
      return client;
    },

    shutdown(): Promise<void> {
      return nodeSdk.shutdown();
    },
  };
}

function describe(client: unknown): string {
  if (client === null) return "null";
  if (typeof client !== "object") return typeof client;
  return client.constructor?.name ?? "an anonymous object";
}
