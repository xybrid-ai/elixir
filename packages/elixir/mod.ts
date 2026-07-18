export { init } from "./src/init.ts";
export { XybridSpanProcessor } from "./src/processor.ts";
export { XybridExporter } from "./src/exporter.ts";
export { startXybridElixir, type StartXybridElixirOptions } from "./src/start.ts";
export { isAISpan } from "./src/is-ai-span.ts";
export {
  spanToEvent,
  isContentAttribute,
  type SpanToEventOptions,
} from "./src/span-to-event.ts";

// Gateway routing + brewers (the `brew` extension point).
export { createFallbackFetch, resolveFallback, traceparentFrom } from "./src/gateway.ts";
export { registerBrewer, findBrewer, openaiBrewer } from "./src/brewers.ts";

export type {
  Brewer,
  BrewContext,
  BrewOptions,
  CircuitPolicy,
  Elixir,
  ElixirInitOptions,
  FallbackPolicy,
  ResolvedFallbackPolicy,
  XybridElixirConfig,
  XybridOTelSpanEvent,
} from "./src/types.ts";
