// @vitest-environment node
// Module 5: one support agent that does everything, compared with Copper and
// the Refund agent on the golden set (EVAL_AGENTS=one npm run eval). It has
// every tool except the handoffs, and handles refunds itself. Mock model, so
// no AI key.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportAgentTools } from "@/lib/copper/assistant/support-agent";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
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

const desk = { limitUsd: 50, refunds: [] };

async function ask(question: string) {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { askSupportAgent } =
    await import("@/lib/copper/assistant/support-agent");
  return askSupportAgent([{ role: "user", content: question }], desk);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("one support agent", () => {
  it("has every tool both agents have, except the handoffs", () => {
    expect(Object.keys(supportAgentTools(desk)).sort()).toEqual([
      "calculate_cost",
      "check_availability",
      "get_orders",
      "get_prices",
      "get_products",
      "request_refund",
      "search_docs",
    ]);
  });

  it("handles a refund itself, with the refund rules in its instructions", async () => {
    model = modelStreaming(
      calls("request_refund", { orderId: "1001" }),
      says("Your $7.99 refund for order #1001 is on its way."),
    );
    const answer = await ask("Please refund order 1001.");

    expect(answer).toEqual({
      reply: "Your $7.99 refund for order #1001 is on its way.",
      tools: ["request_refund"],
      status: "done",
    });
    const system = model.doStreamCalls[0].prompt.find(
      (message) => message.role === "system",
    );
    expect(system?.content).toContain("You also handle refunds yourself");
  });

  it("reports a failed model call as an error", async () => {
    model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("model down");
      },
    });
    const answer = await ask("How much is Copper Home?");
    expect(answer.status).toBe("error");
  });
});
