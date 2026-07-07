import type { Context } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { XybridExporter } from "./exporter.ts";
import { isAISpan } from "./is-ai-span.ts";
import type { XybridElixirConfig } from "./types.ts";

/**
 * A `SpanProcessor` that forwards **only AI-relevant** spans to Xybrid.
 *
 * Filtering happens in `onEnd` so non-AI spans are never buffered; batching,
 * retry, and flush are delegated to a wrapped `BatchSpanProcessor` backed by
 * {@link XybridExporter}.
 */
export class XybridSpanProcessor implements SpanProcessor {
  private readonly delegate: BatchSpanProcessor;

  constructor(config: XybridElixirConfig) {
    this.delegate = new BatchSpanProcessor(new XybridExporter(config));
  }

  onStart(_span: Span, _parentContext: Context): void {
    /* no-op: everything we need is available at onEnd */
  }

  onEnd(span: ReadableSpan): void {
    if (!isAISpan(span)) return;
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
