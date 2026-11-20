// @vitest-environment node
// Module 5: Langfuse tracing. With the Langfuse keys set, the app starts
// Langfuse's tracer and the AI SDK integration once; every AI call is named
// after its feature; each Ask Copper turn is one trace, with each agent inside
// it. Mock model and a stand-in for Langfuse, so no keys or network.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { trace } from "@opentelemetry/api";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

// Records each observation the chat opens, then runs it as usual.
type Observation = {
  name: string;
  asType?: string;
  updates: Record<string, unknown>[];
};
const langfuse = vi.hoisted(() => ({
  observations: [] as Observation[],
  attributes: [] as Record<string, unknown>[],
}));
vi.mock("@langfuse/tracing", () => ({
  propagateAttributes: (params: Record<string, unknown>, fn: () => unknown) => {
    langfuse.attributes.push(params);
    return fn();
  },
  startActiveObservation: (
    name: string,
    fn: (span: { update: (u: Record<string, unknown>) => void }) => unknown,
    options?: { asType?: string },
  ) => {
    const observation: Observation = {
      name,
      asType: options?.asType,
      updates: [],
    };
    langfuse.observations.push(observation);
    return fn({ update: (u) => observation.updates.push(u) });
  },
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls"): StreamPart => ({
  type: "finish",
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: {
      total: 500,
      noCache: 500,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 50, text: 50, reasoning: undefined },
  },
});

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  finish("stop"),
];

const calls = (toolName: string, input: unknown): StreamPart[] => [
  { type: "tool-input-start", id: "call-1", toolName },
  { type: "tool-input-end", id: "call-1" },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

type Registry = { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] };
const integrations = () =>
  (globalThis as Registry).AI_SDK_TELEMETRY_INTEGRATIONS ?? [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  langfuse.observations.length = 0;
  langfuse.attributes.length = 0;
});

describe("Langfuse tracing", () => {
  it("starts nothing without the Langfuse keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "");
    const { startTracing } = await import("@/lib/ai/tracing");
    const before = integrations().length;
    expect(await startTracing()).toBe(false);
    expect(integrations()).toHaveLength(before);
  });

  it("with the keys, starts Langfuse's tracer once, and stops it cleanly", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-test");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-test");
    const tracing = await import("@/lib/ai/tracing");
    const before = integrations().length;

    expect(await tracing.startTracing()).toBe(true);
    expect(await tracing.startTracing()).toBe(true);
    expect(integrations()).toHaveLength(before + 1);
    const provider = trace.getTracerProvider() as {
      getDelegate?: () => object;
    };
    expect(provider.getDelegate?.().constructor.name).toBe(
      "NodeTracerProvider",
    );

    await tracing.flushTraces();
    await tracing.stopTracing();
    expect(integrations()).toHaveLength(before);
  });

  it("starts from instrumentation.ts in the Node.js runtime only", async () => {
    vi.resetModules();
    const startTracing = vi.fn(async () => true);
    vi.doMock("@/lib/ai/tracing", () => ({ startTracing }));
    const { register } = await import("@/instrumentation");

    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(startTracing).not.toHaveBeenCalled();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    await register();
    expect(startTracing).toHaveBeenCalledOnce();
    vi.doUnmock("@/lib/ai/tracing");
  });

  it("names every AI call after its feature", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { registerTelemetry } = await import("ai");
    const started: (string | undefined)[] = [];
    const recorder = {
      onStart: (event: { functionId?: string }) => {
        started.push(event.functionId);
      },
    };
    registerTelemetry(recorder);
    try {
      model = modelStreaming(says("Copper Home costs $149."));
      const { callStream } = await import("@/lib/ai/call");
      const result = callStream(
        { module: 2, feature: "ask-copper" },
        { prompt: "How much is Copper Home?" },
      );
      await result.text;
      expect(started).toContain("ask-copper");
    } finally {
      const registry = globalThis as Registry;
      registry.AI_SDK_TELEMETRY_INTEGRATIONS = integrations().filter(
        (integration) => integration !== recorder,
      );
    }
  });

  it("traces a chat turn as one trace, with each agent inside it", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
    vi.spyOn(console, "info").mockImplementation(() => {});
    model = modelStreaming(
      calls("transfer_to_refund_agent", { reason: "refund order #1001" }),
      says("Your $7.99 refund for order #1001 is on its way."),
    );
    vi.resetModules();
    const { askCopper } = await import("@/lib/copper/assistant/ask");
    const final = await finalValue(
      (
        await askCopper({
          messages: [{ role: "user", content: "Please refund order 1001." }],
          useTools: true,
          desk: { limitUsd: 50, refunds: [] },
        })
      ).progress,
    );

    expect(langfuse.attributes).toEqual([
      { traceName: "Ask Copper", tags: ["support-page"] },
    ]);
    expect(langfuse.observations.map((o) => [o.name, o.asType])).toEqual([
      ["Ask Copper", undefined],
      ["Copper", "agent"],
      ["Refund agent", "agent"],
    ]);
    const [turn, copper, refundAgent] = langfuse.observations;
    expect(turn.updates[0]).toEqual({ input: "Please refund order 1001." });
    expect(turn.updates.at(-1)).toMatchObject({
      output: final.reply,
      metadata: {
        answeredBy: "Refund agent",
        tools: ["transfer_to_refund_agent"],
      },
    });
    expect(copper.updates).toEqual([{ output: { handedTo: "Refund agent" } }]);
    expect(refundAgent.updates).toEqual([{ output: final.reply }]);
  });
});
