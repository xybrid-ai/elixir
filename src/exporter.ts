import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

import { spanToEvent } from "./span-to-event.ts";
import type { XybridElixirConfig, XybridOTelSpanEvent } from "./types.ts";

const DEFAULT_ENDPOINT = "https://otel.xybrid.ai/v1/spans";

/**
 * OTel `SpanExporter` that maps spans to Xybrid span events and POSTs them to the
 * `/v1/spans` ingest endpoint. Pair it with a batching processor — either the
 * bundled {@link XybridSpanProcessor} (which also filters to AI spans) or a stock
 * `BatchSpanProcessor`.
 */
export class XybridExporter implements SpanExporter {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private shuttingDown = false;

  constructor(config: XybridElixirConfig) {
    if (!config.apiKey) throw new Error("XybridExporter: `apiKey` is required");
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("XybridExporter: no global `fetch`; pass `fetchImpl` (Node < 18)");
    }
    this.fetchImpl = fetchImpl;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shuttingDown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error("exporter is shut down") });
      return;
    }
    const events = spans.map(spanToEvent);
    if (events.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.send(events).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (error: unknown) =>
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
  }

  async forceFlush(): Promise<void> {
    /* nothing buffered here — the processor owns batching */
  }

  private async send(events: XybridOTelSpanEvent[]): Promise<void> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      throw new Error(`xybrid span ingest failed: ${res.status} ${res.statusText}`);
    }
  }
}
