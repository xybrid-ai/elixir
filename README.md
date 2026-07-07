# @xybrid/elixir

The **Elixir SDK** — ship your app's AI/LLM spans to Xybrid with no change to how
you call your provider. Xybrid uses them to tell you whether your calls **behave
correctly**, where you can **cut cost**, and (later) to run **evals** on your real
inputs and distill task-specific models.

This is the **OTel / Mode B** integration surface: your app keeps calling the
provider directly; the SDK observes AI spans (via OpenTelemetry instrumentations)
and forwards only the AI-relevant ones to Xybrid's span-ingest endpoint. Xybrid is
**not** in your request hot path. (Design: `docs/otel-modes-implementation-plan.md`
in the `xybrid-meta` workstation.)

> **Status:** early. Ships the Node span processor + exporter (plan Step 1). The
> `/v1/spans` ingest endpoint is under construction; the ingestion worker is a
> separate, not-yet-built service.

## Install

Published on [JSR](https://jsr.io/@xybrid/elixir):

```bash
# npm / pnpm / yarn / bun projects
npx jsr add @xybrid/elixir
# deno
deno add jsr:@xybrid/elixir

# plus the OTel API and the instrumentation(s) for the SDKs you use, e.g.:
pnpm add @opentelemetry/api @traceloop/instrumentation-anthropic
```

## Quickstart

```ts
import { startXybridElixir } from "@xybrid/elixir";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";

const sdk = startXybridElixir({
  apiKey: process.env.XYBRID_API_KEY!,
  projectId: process.env.XYBRID_PROJECT_ID,
  serviceName: "my-app",
  instrumentations: [new AnthropicInstrumentation()],
});
// ... run your app; call Anthropic/OpenAI as usual, no base-URL change ...
// on shutdown: await sdk.shutdown();
```

### Bring your own OTel setup

If you already configure a `NodeSDK`, just add the span processor:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { XybridSpanProcessor } from "@xybrid/elixir";

const sdk = new NodeSDK({
  spanProcessors: [new XybridSpanProcessor({ apiKey: process.env.XYBRID_API_KEY! })],
  instrumentations: [/* ... */],
});
sdk.start();
```

## What gets sent

The processor keeps **only AI-relevant spans** (`isAISpan` — OTel `gen_ai.*`, the
older `llm.*`, Traceloop's marker, or an `openai`/`anthropic` span name) and the
exporter POSTs them, batched, to the ingest endpoint:

```
POST {endpoint}   Authorization: Bearer {apiKey}
{ "events": [ { event_type: "otel.span.completed", trace_id, span_id, provider,
                model, input_tokens, output_tokens, duration_ms, attributes, … } ] }
```

See `XybridOTelSpanEvent` in [`src/types.ts`](src/types.ts) for the full shape.
`customer_id` is resolved server-side from the API key and is never sent by the SDK.

## Config

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | required; sent as a bearer token |
| `endpoint` | `https://otel.xybrid.ai/v1/spans` | full ingest URL |
| `fetchImpl` | global `fetch` | pass one on Node < 18 or to mock in tests |

## Public API

| Export | Purpose |
|---|---|
| `startXybridElixir(options)` | one-call `NodeSDK` setup; returns the started SDK |
| `XybridSpanProcessor` | filters AI spans, batches, forwards to the exporter |
| `XybridExporter` | maps spans → events and POSTs to `/v1/spans` |
| `isAISpan`, `spanToEvent` | the filter + mapper, exported for reuse/testing |
| `XybridElixirConfig`, `XybridOTelSpanEvent` | types |

## Examples

- [Vercel AI SDK](examples/vercel-ai-sdk/) — start Elixir + `experimental_telemetry: { isEnabled: true }`; no base-URL change.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build       # emits dist/ (.js + .d.ts) for local/npm-style consumers
```

Publishing (JSR reads `jsr.json`; TypeScript source is published as-is, no build):

```bash
npx jsr publish --dry-run   # verify
npx jsr publish
```

## Roadmap (from the plan)

- **Content capture** — carry prompt/response content (when the instrumentation
  captures it) so Xybrid can run evals + distillation, not just behavior + cost.
- **Python SDK** — mirror this for PydanticAI / LangChain server-side.
- **Mode C correlation** — when also routing through the Xybrid gateway, share
  `trace_id` so gateway events and these spans join.
