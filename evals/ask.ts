// Asks Ask Copper one golden-set question the way the chat panel does (both
// agents, with their tools) and returns the final reply and the tools used.
// Module 5: askSupportAgentOnce asks the one support agent that does
// everything instead, for the comparison (EVAL_AGENTS=one).
import { finalValue } from "@/lib/ai/live";
import { askCopper } from "@/lib/copper/assistant/ask";
import { type Agent, toolCallsOf } from "@/lib/copper/assistant/progress";
import { askSupportAgent } from "@/lib/copper/assistant/support-agent";
import { DEFAULT_LIMIT_USD } from "@/lib/copper/orders";
import type { GoldenInput } from "./golden-set";

export type CopperAnswer = {
  reply: string;
  /** Who wrote the reply: Copper, the Refund agent, or the one support agent. */
  agent: Agent | "support";
  /** "error" when a model call failed; the reply is then Copper's apology. */
  status: "done" | "error";
  /** Every tool Copper and the Refund agent called, in order. */
  tools: string[];
};

export async function askCopperOnce({
  question,
  support,
}: GoldenInput): Promise<CopperAnswer> {
  const { progress } = await askCopper({
    messages: [{ role: "user", content: question }],
    useTools: true,
    // The Support page starts with the default limit and no refunds yet.
    desk: support ? { limitUsd: DEFAULT_LIMIT_USD, refunds: [] } : undefined,
  });
  const final = await finalValue(progress);
  return {
    reply: final.reply,
    agent: final.agent ?? "copper",
    status: final.status === "error" ? "error" : "done",
    tools: toolCallsOf(final).map((call) => call.name),
  };
}

/** The same question for the one support agent, which always has the refund tools. */
export async function askSupportAgentOnce({
  question,
}: GoldenInput): Promise<CopperAnswer> {
  const answer = await askSupportAgent([{ role: "user", content: question }], {
    limitUsd: DEFAULT_LIMIT_USD,
    refunds: [],
  });
  return { ...answer, agent: "support" };
}
