# Xybrid Elixir (Node/TypeScript)

Monorepo for **Xybrid Elixir**, Xybrid's OpenTelemetry-based AI observability
layer. ("Elixir" is the product name — this is not an Elixir-language SDK.)

| Package | What it is |
|---|---|
| [`@xybrid/elixir`](packages/elixir/) | The SDK: observes AI/LLM spans via OTel instrumentations and ships them to Xybrid's span-ingest endpoint. |
| [`@xybrid/dev-listener`](packages/dev-listener/) | Local dev server that receives those spans and pretty-prints them, so you can test span collection without the real backend. |

## Develop

```bash
pnpm install
pnpm typecheck   # all packages
pnpm test        # all packages
pnpm build       # all packages (emits dist/)
```

## Publish (JSR)

Each package has its own `jsr.json`; dry-run/publish from the package directory:

```bash
cd packages/elixir && npx jsr publish --dry-run
cd packages/dev-listener && npx jsr publish --dry-run
```
