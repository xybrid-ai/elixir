import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname } from "node:path";

import { formatEvent } from "./format.ts";
import { normalizeSpanEvent } from "./normalize.ts";
import { RingBuffer } from "./ring-buffer.ts";
import type { NormalizedSpanEvent, XybridOTelSpanEvent } from "./types.ts";

export interface DevListenerOptions {
  /** @default 4319 */
  port?: number;
  /**
   * Interface to bind. Loopback by default — this tool is local-only and
   * `/events` can expose content; pass `"0.0.0.0"` explicitly to accept spans
   * from other machines.
   * @default "127.0.0.1"
   */
  host?: string;
  /** Keep content-bearing attribute values instead of `"[redacted]"`. @default false */
  captureContent?: boolean;
  /** Append one normalized event per line to this NDJSON file. */
  out?: string;
  /** Print normalized JSON lines instead of pretty summaries. @default false */
  json?: boolean;
  /** In-memory ring buffer capacity for `GET /events`. @default 500 */
  bufferSize?: number;
  /** Sink for per-span output. @default console.log */
  log?: (line: string) => void;
  /** Sink for warnings (malformed events, NDJSON write failures). @default console.warn */
  warn?: (line: string) => void;
}

export interface DevListener {
  server: Server;
  /** The bound port (useful when started with `port: 0`). */
  port: number;
  /** Ingest URL, e.g. `http://localhost:4319/v1/spans`. */
  url: string;
  /** Snapshot of the ring buffer, oldest → newest. */
  events(): NormalizedSpanEvent[];
  close(): Promise<void>;
}

/** A structurally valid span event: the fields the listener relies on exist. */
function isValidEvent(value: unknown): value is XybridOTelSpanEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.trace_id === "string" &&
    typeof e.span_id === "string" &&
    typeof e.name === "string" &&
    (e.attributes === undefined || (typeof e.attributes === "object" && e.attributes !== null))
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Start the dev listener. Resolves once the server is bound. */
export async function startDevListener(options: DevListenerOptions = {}): Promise<DevListener> {
  const captureContent = options.captureContent ?? false;
  const json = options.json ?? false;
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const buffer = new RingBuffer<NormalizedSpanEvent>(options.bufferSize ?? 500);

  if (options.out) await mkdir(dirname(options.out), { recursive: true });

  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && url === "/healthz") {
      respond(200, { ok: true });
      return;
    }

    if (req.method === "GET" && url === "/events") {
      respond(200, { events: buffer.toArray() });
      return;
    }

    if (req.method === "POST" && url === "/v1/spans") {
      readBody(req)
        .then(async (raw) => {
          let payload: unknown;
          try {
            payload = JSON.parse(raw);
          } catch {
            respond(400, { error: "invalid JSON" });
            return;
          }
          const events = (payload as { events?: unknown })?.events;
          if (!Array.isArray(events)) {
            respond(400, { error: "expected { events: [...] }" });
            return;
          }

          const lines: string[] = [];
          let accepted = 0;
          for (const event of events) {
            if (!isValidEvent(event)) {
              warn(`xybrid-dev-listener: skipping malformed event: ${JSON.stringify(event)}`);
              continue;
            }
            const normalized = normalizeSpanEvent(event, { captureContent });
            buffer.push(normalized);
            log(json ? JSON.stringify(normalized) : formatEvent(normalized));
            lines.push(JSON.stringify(normalized));
            accepted += 1;
          }

          if (options.out && lines.length > 0) {
            try {
              await appendFile(options.out, `${lines.join("\n")}\n`, "utf8");
            } catch (error) {
              warn(`xybrid-dev-listener: failed to write ${options.out}: ${String(error)}`);
            }
          }

          respond(202, { accepted });
        })
        .catch((error: unknown) => {
          respond(500, { error: String(error) });
        });
      return;
    }

    respond(404, { error: "not found" });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4319, host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 4319);
  const displayHost = ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(host) ? "localhost" : host;

  return {
    server,
    port,
    url: `http://${displayHost}:${port}/v1/spans`,
    events: () => buffer.toArray(),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
