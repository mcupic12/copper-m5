"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: each turn is one Langfuse trace, "Ask Copper", with each agent
// inside it and that agent's model and tool calls under it (lib/ai/tracing.ts).
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { hasToolCall, stepCountIs } from "ai";
import { after } from "next/server";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { flushTraces } from "@/lib/ai/tracing";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import {
  AGENT_NAMES,
  type Agent,
  type Progress,
  type ToolStep,
  toolCallsOf,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's call: its instructions and only its own tools. */
function agentCall(agent: Agent, messages: ChatMessage[], desk?: Desk) {
  if (agent === "refund" && desk)
    return callStream(
      { module: 4, feature: "refund-agent" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions: REFUND_AGENT_INSTRUCTIONS,
        tools: refundAgentTools(desk),
        stopWhen: STOP,
      },
    );
  return callStream(
    { module: 2, feature: "ask-copper" },
    {
      messages,
      providerOptions: THOUGHT_SUMMARIES,
      instructions: desk
        ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
        : COPPER_INSTRUCTIONS,
      tools: desk
        ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
        : copperTools,
      stopWhen: STOP,
    },
  );
}

export async function askCopper({
  messages,
  useTools,
  desk,
  agent = "copper",
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const first: Agent = desk && useTools ? agent : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /** Reads one agent's stream into progress. Returns who to hand off to. */
  async function follow(
    current: Agent,
    result: ReturnType<typeof callStream>,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking" && last.agent === current)
            last.text += part.text;
          else
            progress.steps.push({
              type: "thinking",
              text: part.text,
              agent: current,
            });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: `${call}:${part.id}`,
            agent: current,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.toolCallId}`,
              agent: current,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          if (part.toolName in HANDOFF_TOOLS)
            handoff = HANDOFF_TOOLS[part.toolName];
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message =
            part.error instanceof Error
              ? part.error.message
              : String(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
    return handoff;
  }

  /** One agent's part of the turn, traced in Langfuse as that agent. */
  const runAgent = (
    agent: Agent,
    stream: () => ReturnType<typeof callStream>,
  ) =>
    startActiveObservation(
      AGENT_NAMES[agent],
      async (span) => {
        const handoff = await follow(agent, stream());
        span.update({
          output: handoff ? { handedTo: AGENT_NAMES[handoff] } : progress.reply,
        });
        return handoff;
      },
      { asType: "agent" },
    );

  // Once the reply has been sent, send this turn's trace to Langfuse, before
  // a serverless function stops. Outside a request (the tests, the eval)
  // there's no reply to wait for, and after() throws.
  try {
    after(flushTraces);
  } catch {
    // Not in a request: nothing to wait for.
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      await propagateAttributes(
        {
          traceName: "Ask Copper",
          tags: [desk ? "support-page" : "home-page"],
        },
        () =>
          startActiveObservation("Ask Copper", async (turn) => {
            turn.update({ input: messages.at(-1)?.content ?? "" });
            if (!useTools) {
              // Without tools, send no instructions either: "always use
              // your tools" with no tools makes the model answer with nothing.
              await runAgent("copper", () =>
                callStream(
                  { module: 2, feature: "ask-copper" },
                  { messages, providerOptions: THOUGHT_SUMMARIES },
                ),
              );
            } else {
              let current = first;
              for (let handoffs = 0; ; handoffs++) {
                const agent = current;
                const next = await runAgent(agent, () =>
                  agentCall(agent, messages, desk),
                );
                if (!next || next === current || handoffs >= MAX_HANDOFFS)
                  break;
                progress.steps.push({
                  type: "handoff",
                  from: current,
                  to: next,
                });
                progress.agent = current = next;
                progress.reply = "";
                call++;
                update(snapshot());
              }
            }
            turn.update({
              output: progress.reply,
              metadata: {
                answeredBy: AGENT_NAMES[progress.agent ?? "copper"],
                tools: toolCallsOf(progress).map((step) => step.name),
              },
            });
          }),
      );
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    done(snapshot());
  })();

  return { progress: live };
}
