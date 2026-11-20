// The golden set (Module 5): questions customers ask Ask Copper, each with
// what a correct answer says and the tools Copper should use to find it. The
// questions live in golden-set.json; this file checks their shape and turns
// each one into an eval item.
import { z } from "zod";
import data from "./golden-set.json";

export const goldenItemSchema = z.object({
  /** Short and stable: Langfuse keeps each item's history under it. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  question: z.string().min(3),
  /** What a correct answer says (or must not say). The AI judge compares with it. */
  expected: z.string().min(3),
  /** Tools the answer must use; "a|b" means either one will do. */
  tools: z.array(z.string()),
  /** Asked on the Support page, where refunds go to the Refund agent. */
  support: z.boolean().optional(),
});

export type GoldenItem = z.infer<typeof goldenItemSchema>;

export const goldenSetSchema = z.object({
  /** The Langfuse dataset the golden set is kept in. */
  dataset: z.string().min(1),
  description: z.string(),
  items: z.array(goldenItemSchema).min(1),
});

export const GOLDEN_SET = goldenSetSchema.parse(data);

/** What Ask Copper gets for one item: the eval's input. */
export type GoldenInput = { question: string; support: boolean };

/** What the tool check needs besides the expected answer. */
export type GoldenMetadata = { goldenId: string; tools: string[] };

/** The Langfuse dataset item id of a golden item. */
export const datasetItemId = (item: GoldenItem) =>
  `${GOLDEN_SET.dataset}-${item.id}`;

/** One golden item as an eval item: input, expected output and metadata. */
export function toExperimentItem(item: GoldenItem): {
  input: GoldenInput;
  expectedOutput: string;
  metadata: GoldenMetadata;
} {
  return {
    input: { question: item.question, support: item.support ?? false },
    expectedOutput: item.expected,
    metadata: { goldenId: item.id, tools: item.tools },
  };
}
