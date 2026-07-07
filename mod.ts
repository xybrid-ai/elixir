export { XybridSpanProcessor } from "./src/processor.ts";
export { XybridExporter } from "./src/exporter.ts";
export { startXybridElixir, type StartXybridElixirOptions } from "./src/start.ts";
export { isAISpan } from "./src/is-ai-span.ts";
export {
  spanToEvent,
  isContentAttribute,
  type SpanToEventOptions,
} from "./src/span-to-event.ts";
export type { XybridElixirConfig, XybridOTelSpanEvent } from "./src/types.ts";
