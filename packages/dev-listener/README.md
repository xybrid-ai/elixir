# @xybrid/dev-listener

Local span listener for testing [`@xybrid/elixir`](../elixir/) — receive your
app's AI/LLM spans on `http://localhost:4319/v1/spans` and pretty-print them,
no Xybrid backend needed.

## Run

From this repo:

```bash
pnpm --filter @xybrid/dev-listener start
# Xybrid dev listener listening on http://localhost:4319/v1/spans
```

(`npx @xybrid/dev-listener` will work once the package is published to npm —
a JSR-only publish does not expose the CLI binary.)

The listener binds to `127.0.0.1` only; pass `--host 0.0.0.0` to accept spans
from other machines.

## Point the SDK at it

```ts
import { startXybridElixir } from "@xybrid/elixir";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";

startXybridElixir({
  apiKey: "dev",
  endpoint: "http://localhost:4319/v1/spans",
  serviceName: "my-app",
  instrumentations: [new AnthropicInstrumentation()],
});
```

Each AI call your app makes prints as:

```
[14:22:01] anthropic claude-3-5-sonnet-latest
  span: anthropic.messages.create
  trace: 8f3c1a2b... / span: 91ab23cd...
  tokens: 1200 in / 240 out
  duration: 920ms
  status: success
```

## Options

| Flag | Default | Notes |
|---|---|---|
| `--port <n>` | `4319` | HTTP port |
| `--host <addr>` | `127.0.0.1` | interface to bind; loopback only by default |
| `--out <file>` | — | append one normalized event per line (NDJSON); parent dirs are created |
| `--capture-content` | off | keep prompt/response/tool content; by default content-bearing attribute values become `"[redacted]"` (keys are kept — token/usage counts are never redacted) |
| `--json` | off | print normalized JSON lines instead of pretty summaries |

## Endpoints

| Endpoint | Behavior |
|---|---|
| `POST /v1/spans` | accepts `{ "events": [...] }` as emitted by the SDK; responds `202 { "accepted": n }`; invalid JSON → `400`; malformed events are skipped with a warning |
| `GET /events` | last 500 normalized events (in-memory ring buffer) |
| `GET /healthz` | `{ "ok": true }` |

## Programmatic use

```ts
import { startDevListener } from "@xybrid/dev-listener";

const listener = await startDevListener({ port: 0 }); // ephemeral port
console.log(listener.url);      // http://localhost:<port>/v1/spans
listener.events();              // NormalizedSpanEvent[]
await listener.close();
```

Normalization helpers (`normalizeSpanEvent`, `inferProvider`, `inferModel`,
`inferOperation`, token inference, `sanitizeAttributes`, `isGenAISpan`) and
`RingBuffer` are exported too.

## Non-goals

Local-only and boring on purpose: no real ingest, no storage, no queues, no UI.
