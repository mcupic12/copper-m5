// Langfuse tracing (Module 5). With the Langfuse keys set, every AI call goes
// to Langfuse: each agent, its model calls and tool calls, with tokens, cost
// and time. instrumentation.ts starts it when the server starts, and the
// golden-set eval starts it for its runs. Without the keys nothing is sent and
// the app works the same.
// The tracing packages load only when tracing starts, so importing this file
// for flushTraces stays cheap.

type Tracing = {
  provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> };
  integration: unknown;
};

// Kept on globalThis: Next.js loads instrumentation.ts and the server actions
// as separate bundles, and both must use the same tracer. The AI SDK keeps
// its registered integrations there too.
const state = globalThis as typeof globalThis & {
  copperTracing?: Tracing;
  AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[];
};

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** Starts sending traces to Langfuse, once. False when its keys aren't set. */
export async function startTracing(): Promise<boolean> {
  if (state.copperTracing) return true;
  if (!isTracingConfigured()) return false;
  const [
    { LangfuseSpanProcessor },
    { LangfuseVercelAiSdkIntegration },
    { NodeTracerProvider },
    { registerTelemetry },
  ] = await Promise.all([
    import("@langfuse/otel"),
    import("@langfuse/vercel-ai-sdk"),
    import("@opentelemetry/sdk-trace-node"),
    import("ai"),
  ]);
  // Langfuse's default filter sends only AI and Langfuse spans, not the
  // spans Next.js makes for every request.
  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  provider.register();
  // Every AI SDK call (generateText, streamText, embedMany) reports to Langfuse.
  const integration = new LangfuseVercelAiSdkIntegration();
  registerTelemetry(integration);
  state.copperTracing = { provider, integration };
  return true;
}

/** Sends the traces still waiting. The chat calls it after each reply, before a serverless function stops. */
export async function flushTraces(): Promise<void> {
  await state.copperTracing?.provider.forceFlush();
}

/** Sends what's left and stops tracing (the eval, when it's done). */
export async function stopTracing(): Promise<void> {
  const tracing = state.copperTracing;
  if (!tracing) return;
  state.copperTracing = undefined;
  await tracing.provider.shutdown();
  const { trace } = await import("@opentelemetry/api");
  trace.disable();
  state.AI_SDK_TELEMETRY_INTEGRATIONS =
    state.AI_SDK_TELEMETRY_INTEGRATIONS?.filter(
      (integration) => integration !== tracing.integration,
    );
}
