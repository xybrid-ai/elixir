# Elixir × Vercel AI SDK

Send [Vercel AI SDK](https://sdk.vercel.ai) telemetry to Xybrid Elixir with no
change to how you call your model — just start Elixir and flip telemetry on.

## The whole integration

```ts
import { openai } from "@ai-sdk/openai";
import { startXybridElixir } from "@xybrid/elixir";
import { generateText } from "ai";

startXybridElixir({ apiKey: process.env.XYBRID_API_KEY! });   // ← 1. start Elixir

await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "...",
  experimental_telemetry: { isEnabled: true },                // ← 2. turn telemetry on
});
```

That's it. The AI SDK emits an `ai.generateText.doGenerate` span carrying the
`gen_ai.*` semantic-convention attributes (system, model, token usage); Elixir's
span processor recognizes it, maps it to a Xybrid span event, and POSTs it to the
ingest endpoint — off your request's hot path.

## Run it

```bash
# from libs/elixir: build the SDK the example links to
pnpm --dir ../.. build

pnpm install
export XYBRID_API_KEY=xyk_...
export OPENAI_API_KEY=sk-...
export XYBRID_PROJECT_ID=proj_...   # optional
pnpm start
```

## What Xybrid receives

Only the model-call span is forwarded (the outer `ai.generateText` orchestration
span has no `gen_ai.*` attributes, so it's filtered out). The event looks like:

```json
{
  "event_type": "otel.span.completed",
  "name": "ai.generateText.doGenerate",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "input_tokens": 12,
  "output_tokens": 8,
  "total_tokens": 20,
  "service_name": "vercel-ai-sdk-example",
  "duration_ms": 250,
  "status_code": "OK"
}
```

> Targets AI SDK v4 (`ai@^4`). The `experimental_telemetry` option and the
> `gen_ai.*` span attributes are also present in v5. The attribute mapping is
> covered by `src/vercel-ai-sdk.integration.test.ts` in the SDK package, so it
> stays verified even though this example needs live API keys to run.
