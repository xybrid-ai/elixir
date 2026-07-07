#!/usr/bin/env node
import { parseArgs } from "node:util";

import { startDevListener } from "./server.ts";

const USAGE = `xybrid-dev-listener — local span listener for @xybrid/elixir

Usage:
  xybrid-dev-listener [options]

Options:
  --port <n>          HTTP port (default: 4319)
  --out <file>        append normalized events to an NDJSON file
  --capture-content   keep prompt/response content instead of "[redacted]"
  --json              print normalized JSON lines instead of pretty summaries
  -h, --help          show this help

Endpoints:
  POST /v1/spans      span ingest (point the SDK's \`endpoint\` here)
  GET  /events        last 500 normalized events
  GET  /healthz       liveness check`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let values: {
    port?: string;
    out?: string;
    "capture-content"?: boolean;
    json?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        out: { type: "string" },
        "capture-content": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const port = values.port === undefined ? 4319 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`xybrid-dev-listener: invalid --port ${values.port}`);
    process.exitCode = 1;
    return;
  }

  const listener = await startDevListener({
    port,
    out: values.out,
    captureContent: values["capture-content"],
    json: values.json,
  });

  console.log(`Xybrid dev listener listening on ${listener.url}`);
  if (!values["capture-content"]) {
    console.log("content-bearing attributes are redacted; pass --capture-content to keep them");
  }
  if (values.out) console.log(`appending NDJSON to ${values.out}`);

  const shutdown = (): void => {
    void listener.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
