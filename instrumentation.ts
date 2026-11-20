// Runs once when the Next.js server starts. Module 5: starts Langfuse
// tracing (lib/ai/tracing.ts), so every AI call is traced when the Langfuse
// keys are set. Node.js only: the tracing packages don't run in the Edge
// runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("./lib/ai/tracing");
    await startTracing();
  }
}
