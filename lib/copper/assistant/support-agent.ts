// Module 5: one support agent that does everything, compared with Ask
// Copper's two agents (Copper and the Refund agent) on the golden set. It has
// Copper's tools plus the Refund agent's, without the handoffs, and one set of
// instructions. Only the eval uses it (EVAL_AGENTS=one npm run eval); the site
// keeps the two agents. Traced in Langfuse as the agent "Support agent".
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { SUPPORT_AGENT_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import { alwaysAnswer, STOP } from "@/lib/copper/assistant/steps";
import { copperTools, refundAgentTools } from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

type Message = { role: "user" | "assistant"; content: string };

/** Every tool both agents have, except the handoffs between them. */
export function supportAgentTools(desk: Desk) {
  const refund = refundAgentTools(desk);
  return {
    ...copperTools,
    get_orders: refund.get_orders,
    request_refund: refund.request_refund,
  };
}

export type SupportAnswer = {
  reply: string;
  /** Every tool the agent called, in order. */
  tools: string[];
  /** "error" when a model call failed. */
  status: "done" | "error";
};

export function askSupportAgent(
  messages: Message[],
  desk: Desk,
): Promise<SupportAnswer> {
  return propagateAttributes(
    { traceName: "Support agent", tags: ["one-agent"] },
    () =>
      startActiveObservation(
        "Support agent",
        async (span): Promise<SupportAnswer> => {
          span.update({ input: messages.at(-1)?.content ?? "" });
          try {
            const result = callStream(
              { module: 5, feature: "support-agent" },
              {
                messages,
                providerOptions: THOUGHT_SUMMARIES,
                instructions: SUPPORT_AGENT_INSTRUCTIONS,
                tools: supportAgentTools(desk),
                stopWhen: STOP,
                prepareStep: alwaysAnswer(),
              },
            );
            const [reply, steps] = await Promise.all([
              result.text,
              result.steps,
            ]);
            const tools = steps.flatMap((step) =>
              step.toolCalls.map((call) => call.toolName),
            );
            span.update({ output: reply, metadata: { tools } });
            return { reply, tools, status: "done" };
          } catch (error) {
            span.update({ level: "ERROR", statusMessage: String(error) });
            return { reply: "", tools: [], status: "error" };
          }
        },
        { asType: "agent" },
      ),
  );
}
