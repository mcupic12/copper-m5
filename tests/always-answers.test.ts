// @vitest-environment node
// Module 5: every agent's turn ends in a reply. Copper once searched the
// documents five times and never answered; now, after two searches or on the
// last step allowed, no tools are offered, so the model has to write. Code,
// not instructions, like the refund rule (lib/copper/assistant/steps.ts).
// Mock model, so no AI key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalValue } from "@/lib/ai/live";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));
// search_docs embeds the query: answer with a real passage's embedding.
vi.mock("@/lib/ai/call", async (importOriginal) => {
  const { PASSAGES } = await import("@/lib/copper/passages");
  return {
    ...(await importOriginal<typeof import("@/lib/ai/call")>()),
    callEmbedMany: async () => ({ embeddings: [PASSAGES[0].embedding] }),
  };
});

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

let callId = 0;
const calls = (toolName: string, input: unknown): StreamPart[] => {
  const id = `call-${++callId}`;
  return [
    { type: "tool-input-start", id, toolName },
    { type: "tool-input-end", id },
    {
      type: "tool-call",
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    finish("tool-calls"),
  ];
};

function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

async function ask(
  request: Parameters<typeof import("@/lib/copper/assistant/ask").askCopper>[0],
) {
  vi.resetModules();
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { askCopper } = await import("@/lib/copper/assistant/ask");
  return finalValue((await askCopper(request)).progress);
}

/** The tools offered to the model on each step. */
const offered = () =>
  model.doStreamCalls.map((call) => (call.tools ?? []).map((t) => t.name));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("every agent's turn ends in a reply", () => {
  it("searches at most twice, then answers with no tools offered", async () => {
    model = modelStreaming(
      calls("search_docs", { query: "Copper Home waterproof" }),
      calls("search_docs", { query: "Copper Home outdoor water" }),
      says("I couldn't find that in our support docs."),
    );
    const final = await ask({
      messages: [{ role: "user", content: "Is Copper Home waterproof?" }],
      useTools: true,
    });

    expect(offered()[0]).toContain("search_docs");
    expect(model.doStreamCalls[1].toolChoice).not.toEqual({ type: "none" });
    expect(model.doStreamCalls[2].toolChoice).toEqual({ type: "none" });
    expect(model.doStreamCalls).toHaveLength(3);
    expect(final.status).toBe("done");
    expect(final.reply).toBe("I couldn't find that in our support docs.");
  });

  it("leaves a normal answer alone: every tool offered, the model chooses", async () => {
    model = modelStreaming(
      calls("get_prices", {}),
      says("Copper Home costs $149."),
    );
    const final = await ask({
      messages: [{ role: "user", content: "How much is Copper Home?" }],
      useTools: true,
    });

    expect(offered()[1]).toContain("search_docs");
    expect(model.doStreamCalls[1].toolChoice).not.toEqual({ type: "none" });
    expect(final.reply).toBe("Copper Home costs $149.");
  });

  it("makes the Refund agent answer on its last step too", async () => {
    model = modelStreaming(
      calls("get_orders", {}),
      calls("get_orders", {}),
      calls("get_orders", {}),
      calls("get_orders", {}),
      says("Which order would you like refunded?"),
    );
    const final = await ask({
      messages: [{ role: "user", content: "I want a refund." }],
      useTools: true,
      desk: { limitUsd: 50, refunds: [] },
      agent: "refund",
    });

    expect(model.doStreamCalls[4].toolChoice).toEqual({ type: "none" });
    expect(final.agent).toBe("refund");
    expect(final.reply).toBe("Which order would you like refunded?");
  });
});
