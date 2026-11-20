// npm run langfuse:connect: gives Langfuse your Google key as an "LLM
// connection", so Langfuse's own LLM-as-a-Judge (npm run langfuse:judge) can
// call Gemini. It's the same as Langfuse > Settings > LLM Connections > Add,
// without hunting for the button. It reads GOOGLE_GENERATIVE_AI_API_KEY from
// .env.local and sends it straight to Langfuse; the key is never printed.
// Run it again after you change the key.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const PROVIDER = "google-ai-studio";
/** The model the Langfuse judge uses, in case Langfuse's own list doesn't have it yet. */
export const JUDGE_MODELS = ["gemini-3.5-flash-lite"];

/** Creates Langfuse's Google AI Studio connection, or replaces its key. */
export async function connectGoogle(
  client,
  googleKey,
  { log = console.log } = {},
) {
  if (!googleKey) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY is empty in .env.local: paste your Google key there first.",
    );
  }
  await client.api.llmConnections.upsert({
    provider: PROVIDER,
    adapter: "google-ai-studio",
    secretKey: googleKey,
    customModels: JUDGE_MODELS,
    withDefaultModels: true,
  });
  log(
    `Done: Langfuse can call Gemini now (LLM connection "${PROVIDER}"; the key isn't shown).`,
  );
}

async function main() {
  const file = ".env.local";
  if (!existsSync(file)) {
    console.error(
      `langfuse:connect: ${file} not found. Add your keys to it first.`,
    );
    process.exit(1);
  }
  process.loadEnvFile(file);
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.error(
      "langfuse:connect: add LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to .env.local first.",
    );
    process.exit(1);
  }
  // Straight from the file, like npm run ci:secrets.
  const googleKey = parseEnv(
    readFileSync(file, "utf8"),
  ).GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  // Loaded here, so the tests that import this file stay fast.
  const { LangfuseClient } = await import("@langfuse/client");
  try {
    await connectGoogle(new LangfuseClient(), googleKey);
  } catch (error) {
    const message = String(error?.message ?? error);
    console.error(
      `langfuse:connect: ${googleKey ? message.split(googleKey).join("***") : message}`,
    );
    process.exit(1);
  }
}

// Runs only as a script (npm run langfuse:connect), not when a test imports it.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
