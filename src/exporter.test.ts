import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import { XybridExporter } from "./exporter.ts";

function fakeSpan(): ReadableSpan {
  return {
    name: "openai.chat.completions",
    kind: SpanKind.CLIENT,
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
    startTime: [1000, 0],
    endTime: [1000, 0],
    duration: [0, 0],
    status: { code: SpanStatusCode.OK },
    attributes: { "gen_ai.system": "openai" },
    resource: { attributes: {} },
  } as unknown as ReadableSpan;
}

/** A `vi.fn` typed off the real `fetch` signature so `mock.calls` is well-typed. */
function mockFetch(status: number) {
  return vi.fn(
    async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(null, { status }),
  );
}

function exportOnce(exporter: XybridExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(spans, resolve));
}

describe("XybridExporter", () => {
  it("POSTs { events } to the ingest endpoint with a bearer token", async () => {
    const fetchImpl = mockFetch(200);
    const exporter = new XybridExporter({
      apiKey: "xyk_test",
      endpoint: "https://otel.test/v1/spans",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await exportOnce(exporter, [fakeSpan()]);
    expect(result.code).toBe(ExportResultCode.SUCCESS);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://otel.test/v1/spans");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer xyk_test");
    const body = JSON.parse(init!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ event_type: "otel.span.completed", provider: "openai" });
  });

  it("reports FAILED on a non-2xx ingest response", async () => {
    const exporter = new XybridExporter({
      apiKey: "xyk_test",
      fetchImpl: mockFetch(500) as unknown as typeof fetch,
    });
    const result = await exportOnce(exporter, [fakeSpan()]);
    expect(result.code).toBe(ExportResultCode.FAILED);
  });

  it("requires an apiKey", () => {
    expect(() => new XybridExporter({ apiKey: "" })).toThrow(/apiKey/);
  });
});
