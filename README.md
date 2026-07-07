# @xybrid/elixir

The Node/TypeScript SDK for **Xybrid Elixir**, Xybrid's OpenTelemetry-based AI
observability layer. ("Elixir" is the product name — this is not an
Elixir-language SDK.) It ships your app's AI/LLM spans to Xybrid with no change
to how you call your provider. Xybrid will use these spans to analyze behavior,
latency, cost, and (later) to run evals on your real inputs and distill
task-specific models; today this package implements the client-side span export
path.

This is the **OTel / Mode B** integration surface: your app keeps calling the
provider directly; the SDK observes AI spans (via OpenTelemetry instrumentations)
and forwards only the AI-relevant ones to Xybrid's span-ingest endpoint. Xybrid is
**not** in your request hot path. (Design: `docs/otel-modes-implementation-plan.md`
in the `xybrid-meta` workstation.)

> **Status:** early. The client SDK (Node span processor + exporter, plan Step 1)
> is implemented. The `/v1/spans` ingest endpoint is under construction; the
> ingestion worker is a separate, not-yet-built service.

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

> **Important:** initialize this **before** importing the SDKs you want to
> instrument — many OTel instrumentations patch modules at load time. Put the
> setup in its own file and import it first.

```ts
// tracing.ts
import { startXybridElixir } from "@xybrid/elixir";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";

export const sdk = startXybridElixir({
  apiKey: process.env.XYBRID_API_KEY!,
  projectId: process.env.XYBRID_PROJECT_ID,
  serviceName: "my-app",
  instrumentations: [new AnthropicInstrumentation()],
});
// on shutdown: await sdk.shutdown();
```

```ts
// app.ts
import "./tracing";
import Anthropic from "@anthropic-ai/sdk";
// ... call Anthropic/OpenAI as usual, no base-URL change ...
```

### Bring your own OTel setup

If your app already creates a `NodeSDK` (e.g. for Datadog, PostHog, Honeycomb),
**do not call `startXybridElixir()`** — a Node process should generally have one
OpenTelemetry SDK instance. Add `XybridSpanProcessor` to the existing
`spanProcessors` array instead:

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

### Content policy

Depending on the instrumentation, span attributes may include prompt, response,
tool input/output, or message content. By default the SDK **strips** these
content-bearing attributes (`gen_ai.prompt.*`, `gen_ai.completion.*`,
`traceloop.entity.input/output`, `ai.prompt.*`, `ai.response.text`, …) before
export and sends only metadata: provider, model, tokens, timing, status. Opt in
with `captureContent: true` if you want Xybrid to receive content (needed later
for evals and distillation):

```ts
startXybridElixir({
  apiKey: process.env.XYBRID_API_KEY!,
  captureContent: true, // default: false
  instrumentations: [new AnthropicInstrumentation()],
});
```

## Config

Options accepted by `XybridSpanProcessor` / `XybridExporter` (`XybridElixirConfig`):

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | required; sent as a bearer token |
| `endpoint` | `https://otel.xybrid.ai/v1/spans` | full ingest URL |
| `captureContent` | `false` | forward prompt/response/tool content attributes (see [Content policy](#content-policy)) |
| `fetchImpl` | global `fetch` | pass one on Node < 18 or to mock in tests |

`startXybridElixir()` accepts all of the above, plus:

| Option | Default | Notes |
|---|---|---|
| `projectId` | — | optional; attached as `xybrid.project_id` resource metadata |
| `serviceName` | — | optional; attached as `service.name` |
| `instrumentations` | `[]` | OTel instrumentations to enable |

## Public API

| Export | Purpose |
|---|---|
| `startXybridElixir(options)` | one-call `NodeSDK` setup; returns the started SDK |
| `XybridSpanProcessor` | filters AI spans, batches, forwards to the exporter |
| `XybridExporter` | maps spans → events and POSTs to `/v1/spans` |
| `isAISpan`, `spanToEvent`, `isContentAttribute` | the filter, mapper, and content-attribute predicate, exported for reuse/testing |
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

- **Content policy, finer-grained** — `captureContent` exists as an on/off
  switch (default off); next is per-field redaction controls for prompt,
  response, tool, and message attributes.
- **Python SDK** — mirror this for PydanticAI / LangChain server-side.
- **Mode C correlation** — when also routing through the Xybrid gateway, share
  `trace_id` so gateway events and these spans join.
