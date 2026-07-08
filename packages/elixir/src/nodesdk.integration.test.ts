import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startXybridElixir } from "./start.ts";

/**
 * End-to-end through the *real* OTel pipeline: a span created via the tracer API
 * flows NodeSDK → XybridSpanProcessor → XybridExporter → (stubbed) `fetch`. No
 * provider, no network — this is what catches real `ReadableSpan` shape issues
 * (hrTime, spanContext, resource, 2.x parent context) that the unit fakes can't.
 */
describe("startXybridElixir — real NodeSDK integration", () => {
  let sdk: NodeSDK | undefined;

  afterEach(async () => {
    await sdk?.shutdown().catch(() => {});
    sdk = undefined;
    vi.unstubAllGlobals();
  });

  it("captures an AI span and POSTs the mapped event", async () => {
    const calls: Array<{ url: unknown; init: Parameters<typeof fetch>[1] }> = [];
    const fetchMock = vi.fn(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls.push({ url, init });
        return new Response(null, { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    sdk = startXybridElixir({
      apiKey: "xyk_itest",
      endpoint: "https://otel.test/v1/spans",
      serviceName: "itest-app",
      projectId: "proj-itest",
    });

    const tracer = trace.getTracer("itest");
    const span = tracer.startSpan("anthropic.messages.create", {
      attributes: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-3-5-sonnet-latest",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 20,
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    // `shutdown()` flushes the batch span processor.
    await sdk.shutdown();
    sdk = undefined;

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = calls[0]!;
    expect(call.url).toBe("https://otel.test/v1/spans");
    const body = JSON.parse(call.init!.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      event_type: "otel.span.completed",
      name: "anthropic.messages.create",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      service_name: "itest-app",
      project_id: "proj-itest",
      status_code: "OK",
    });
    // Real spans carry a 32-hex trace id and 16-hex span id.
    expect(body.events[0].trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.events[0].span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not POST non-AI spans", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    sdk = startXybridElixir({ apiKey: "xyk_itest", endpoint: "https://otel.test/v1/spans" });

    trace.getTracer("itest").startSpan("GET /health").end();

    await sdk.shutdown();
    sdk = undefined;

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
