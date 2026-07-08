import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startDevListener, type DevListener } from "./server.ts";

const silent = { log: () => {}, warn: () => {} };
let listener: DevListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_type: "otel.span.completed",
    trace_id: "8f3c1a2b",
    span_id: "91ab23cd",
    name: "anthropic.messages.create",
    duration_ms: 920,
    attributes: {
      "gen_ai.system": "anthropic",
      "gen_ai.request.model": "claude-3-5-sonnet-latest",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 240,
      "gen_ai.prompt.0.content": "secret prompt",
    },
    ...over,
  };
}

function postSpans(l: DevListener, body: string): Promise<Response> {
  return fetch(l.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("dev listener HTTP endpoints", () => {
  it("accepts a valid batch with 202 { accepted }", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    const res = await postSpans(listener, JSON.stringify({ events: [validEvent(), validEvent()] }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
  });

  it("returns 400 on invalid JSON and on a missing events array", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    expect((await postSpans(listener, "{not json")).status).toBe(400);
    expect((await postSpans(listener, JSON.stringify({ nope: true }))).status).toBe(400);
  });

  it("skips malformed events but accepts the valid ones", async () => {
    const warnings: string[] = [];
    listener = await startDevListener({ port: 0, log: () => {}, warn: (l) => warnings.push(l) });
    const res = await postSpans(
      listener,
      JSON.stringify({ events: [validEvent(), { event_type: "otel.span.completed" }, 42] }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(warnings).toHaveLength(2);
    expect(listener.events()).toHaveLength(1);
  });

  it("redacts content-bearing attributes by default", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    await postSpans(listener, JSON.stringify({ events: [validEvent()] }));
    const { events } = (await (await fetch(`http://localhost:${listener.port}/events`)).json()) as {
      events: Array<{ attributes: Record<string, unknown>; input_tokens: number }>;
    };
    expect(events).toHaveLength(1);
    expect(events[0]!.attributes["gen_ai.prompt.0.content"]).toBe("[redacted]");
    expect(events[0]!.attributes["gen_ai.request.model"]).toBe("claude-3-5-sonnet-latest");
    expect(events[0]!.input_tokens).toBe(1200);
  });

  it("preserves content with captureContent: true", async () => {
    listener = await startDevListener({ port: 0, captureContent: true, ...silent });
    await postSpans(listener, JSON.stringify({ events: [validEvent()] }));
    const [event] = listener.events();
    expect(event!.attributes["gen_ai.prompt.0.content"]).toBe("secret prompt");
  });

  it("GET /healthz returns { ok: true }", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    const res = await fetch(`http://localhost:${listener.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /events returns the ring buffer, bounded by bufferSize", async () => {
    listener = await startDevListener({ port: 0, bufferSize: 2, ...silent });
    await postSpans(
      listener,
      JSON.stringify({
        events: [validEvent({ span_id: "a" }), validEvent({ span_id: "b" }), validEvent({ span_id: "c" })],
      }),
    );
    const { events } = (await (await fetch(`http://localhost:${listener.port}/events`)).json()) as {
      events: Array<{ span_id: string }>;
    };
    expect(events.map((e) => e.span_id)).toEqual(["b", "c"]);
  });

  it("appends sanitized NDJSON lines with --out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xybrid-dev-listener-"));
    const out = join(dir, "nested", "spans.ndjson");
    try {
      listener = await startDevListener({ port: 0, out, ...silent });
      await postSpans(listener, JSON.stringify({ events: [validEvent(), validEvent()] }));
      const lines = (await readFile(out, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.provider).toBe("anthropic");
      expect(parsed.attributes["gen_ai.prompt.0.content"]).toBe("[redacted]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("binds to loopback by default", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    const address = listener.server.address();
    expect(typeof address === "object" && address !== null ? address.address : "").toBe("127.0.0.1");
  });

  it("404s unknown routes", async () => {
    listener = await startDevListener({ port: 0, ...silent });
    const res = await fetch(`http://localhost:${listener.port}/nope`);
    expect(res.status).toBe(404);
  });
});
