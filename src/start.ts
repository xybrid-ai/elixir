import type { Instrumentation } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

import { XybridSpanProcessor } from "./processor.ts";

export interface StartXybridElixirOptions {
  /** Xybrid API key. */
  apiKey: string;
  /** Xybrid project id — attached to spans as `xybrid.project_id`. */
  projectId?: string;
  /** Reported as `service.name`. */
  serviceName?: string;
  /** Override the span-ingest endpoint. */
  endpoint?: string;
  /** OTel instrumentations to enable (e.g. `@traceloop/instrumentation-anthropic`). */
  instrumentations?: Instrumentation[];
  /**
   * Forward content-bearing span attributes (prompts, completions, tool
   * input/output, messages) to Xybrid. Metadata is always sent.
   * @default false
   */
  captureContent?: boolean;
  /** Custom `fetch` implementation (Node < 18 or tests). */
  fetchImpl?: typeof fetch;
}

/**
 * One-call setup: wires a {@link XybridSpanProcessor} into a `NodeSDK` and starts
 * it. Returns the started SDK so the caller can `await sdk.shutdown()` on exit.
 */
export function startXybridElixir(options: StartXybridElixirOptions): NodeSDK {
  if (!options.apiKey) throw new Error("startXybridElixir: `apiKey` is required");

  const attributes: Record<string, string> = {};
  if (options.serviceName) attributes["service.name"] = options.serviceName;
  if (options.projectId) attributes["xybrid.project_id"] = options.projectId;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes(attributes),
    spanProcessors: [
      new XybridSpanProcessor({
        apiKey: options.apiKey,
        endpoint: options.endpoint,
        captureContent: options.captureContent,
        fetchImpl: options.fetchImpl,
      }),
    ],
    instrumentations: options.instrumentations ?? [],
  });
  sdk.start();
  return sdk;
}
