import { openai } from "@ai-sdk/openai";
import { startXybridElixir } from "@xybrid/elixir";
import { generateText } from "ai";

// 1. Start Elixir first, so its span processor is registered before any AI call.
const sdk = startXybridElixir({
  apiKey: process.env.XYBRID_API_KEY!,
  projectId: process.env.XYBRID_PROJECT_ID,
  serviceName: "vercel-ai-sdk-example",
});

async function main() {
  // 2. Call the Vercel AI SDK exactly as you normally would — the only addition
  //    is turning telemetry on. The SDK emits an `ai.*.doGenerate` span carrying
  //    gen_ai.* attributes, which Elixir picks up and forwards.
  const { text, usage } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: "In one sentence, what does an AI observability gateway do?",
    experimental_telemetry: { isEnabled: true },
  });

  console.log("model:", text);
  console.log("usage:", usage);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 3. Flush buffered spans to Xybrid before the process exits.
    await sdk.shutdown();
  });
