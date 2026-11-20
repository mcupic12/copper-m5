// How far an agent's turn may go: the step limit, when a handoff ends it, and
// the rule that every turn ends in a reply (Module 5). Shared by Ask Copper's
// two agents (ask.ts) and the one-agent comparison (support-agent.ts). Kept
// out of ask.ts, which as a "use server" file may export only async functions.
import {
  hasToolCall,
  type PrepareStepFunction,
  stepCountIs,
  type ToolSet,
} from "ai";

/** At most this many model steps (tool calls plus the reply) per agent. */
export const MAX_STEPS = 5;

/** At most this many document searches in one agent's turn. */
export const MAX_SEARCHES = 2;

// A handoff ends the agent's turn: the other agent answers.
export const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

/**
 * Every agent's turn ends in a reply (Module 5). After MAX_SEARCHES searches,
 * or on the last step allowed, no tools are offered, so the model has to
 * answer with what it has. It's code, not instructions, like the refund rule:
 * Copper once searched five times and never answered. (Offering every tool
 * but search_docs isn't enough: the model still tries a third search.)
 */
export function alwaysAnswer(): PrepareStepFunction<ToolSet> {
  return ({ stepNumber, steps }) => {
    const searches = steps
      .flatMap((step) => step.toolCalls)
      .filter((call) => call.toolName === "search_docs").length;
    return stepNumber >= MAX_STEPS - 1 || searches >= MAX_SEARCHES
      ? { toolChoice: "none" }
      : {};
  };
}
