// Langfuse for the golden-set eval (Module 5): keeps the golden set as a
// Langfuse dataset, and sends each run's traces and scores there so runs can
// be compared. The SDK reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and
// LANGFUSE_BASE_URL from the environment.
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { datasetItemId, GOLDEN_SET, toExperimentItem } from "./golden-set";

export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** Connects to Langfuse and starts sending traces. Call `stop` when done so nothing is lost. */
export function startLangfuse() {
  // Langfuse's own tracer, so the eval doesn't change tracing for anything else.
  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  setLangfuseTracerProvider(provider);
  const client = new LangfuseClient();
  return {
    client,
    async stop() {
      await client.flush();
      await provider.shutdown();
      await client.shutdown();
      setLangfuseTracerProvider(null);
    },
  };
}

const isNotFound = (error: unknown) =>
  (error as { statusCode?: number } | null)?.statusCode === 404;

/**
 * Makes the Langfuse dataset match golden-set.json (creating it the first
 * time) and returns its items in the same order as the file.
 */
export async function syncGoldenDataset(client: LangfuseClient) {
  const name = GOLDEN_SET.dataset;
  try {
    await client.api.datasets.get(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await client.api.datasets.create({
      name,
      description: GOLDEN_SET.description,
    });
  }
  for (const item of GOLDEN_SET.items) {
    await client.dataset.createItem({
      datasetName: name,
      id: datasetItemId(item),
      ...toExperimentItem(item),
    });
  }
  // Only this file's items: ones removed from the file stay in Langfuse's history.
  const { items } = await client.dataset.get(name);
  return GOLDEN_SET.items.map((golden) => {
    const item = items.find((i) => i.id === datasetItemId(golden));
    if (!item) throw new Error(`Langfuse is missing golden item ${golden.id}`);
    return item;
  });
}
