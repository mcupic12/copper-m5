// Runs the golden set (Module 5): Ask Copper answers each question, the AI
// judge grades the answer, and a tool check sees whether Copper looked the
// answer up. With the Langfuse keys set, the run is a Langfuse experiment on
// the golden-set dataset, with every trace and score kept there; without
// them it runs on this computer only.
import type {
  Evaluation,
  Evaluator,
  ExperimentItemResult,
  ExperimentTask,
  RunEvaluator,
} from "@langfuse/client";
import { askCopperOnce, type CopperAnswer } from "./ask";
import {
  GOLDEN_SET,
  type GoldenInput,
  type GoldenMetadata,
  toExperimentItem,
} from "./golden-set";
import { judgeAnswer } from "./judge";
import { startLangfuse, syncGoldenDataset } from "./langfuse";
import {
  type ItemScores,
  itemPassed,
  missingTools,
  type Summary,
  summarize,
  VERDICT_SCORES,
} from "./scoring";

/** The experiment's name in Langfuse: the same for every run, so runs line up. */
export const EXPERIMENT_NAME = "Ask Copper golden set";

/** Waits before trying a failed model call again: free Google keys allow only a few calls a minute. */
const RETRY_DELAYS_MS = [20_000, 60_000];

export type RunOptions = {
  /** Names the run, e.g. pr-12-abc1234. */
  runName: string;
  /** Kept with the run in Langfuse: the PR, commit, model and agents. */
  metadata?: Record<string, unknown>;
  /** Questions asked at once. 1 stays under free keys' rate limits. */
  concurrency?: number;
  /** Keep the run, its traces and scores in Langfuse (needs its keys). */
  langfuse: boolean;
  retryDelaysMs?: number[];
};

export type ItemResult = {
  id: string;
  question: string;
  answer: CopperAnswer | null;
  scores: ItemScores;
  /** Each score's comment, like "correctness: correct: gives the $149 price". */
  notes: string[];
};

export type GoldenRun = {
  runName: string;
  summary: Summary;
  /** Every golden item, in file order. */
  items: ItemResult[];
  /** The run in Langfuse, when it was kept there. */
  url?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tries again after each delay while `attempt` throws or `failed` says it failed. */
async function withRetries<T>(
  attempt: () => Promise<T>,
  failed: (result: T) => boolean,
  delays: number[],
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const result = await attempt();
      if (!failed(result) || i >= delays.length) return result;
    } catch (error) {
      if (i >= delays.length) throw error;
    }
    await sleep(delays[i]);
  }
}

/** The task (ask Copper) and the two item scores (judge, tool check). */
function evalSteps(delays: number[]) {
  const task: ExperimentTask<GoldenInput, string, GoldenMetadata> = (item) =>
    withRetries(
      () => askCopperOnce(item.input as GoldenInput),
      (answer) => answer.status === "error",
      delays,
    );

  const correctness: Evaluator<GoldenInput, string, GoldenMetadata> = async ({
    input,
    output,
    expectedOutput,
  }) => {
    const answer = output as CopperAnswer;
    if (answer.status === "error") {
      return {
        name: "correctness",
        value: 0,
        comment:
          "incorrect: Ask Copper failed before answering (often the Google key's rate limit or daily quota)",
      };
    }
    const { verdict, reason } = await withRetries(
      () =>
        judgeAnswer({
          question: input.question,
          expected: expectedOutput ?? "",
          answer: answer.reply,
        }),
      () => false,
      delays,
    );
    return {
      name: "correctness",
      value: VERDICT_SCORES[verdict],
      comment: `${verdict}: ${reason}`,
    };
  };

  const rightTools: Evaluator<GoldenInput, string, GoldenMetadata> = async ({
    output,
    metadata,
  }) => {
    const missing = missingTools(
      metadata?.tools ?? [],
      (output as CopperAnswer).tools,
    );
    return {
      name: "right_tools",
      value: missing.length === 0 ? 1 : 0,
      comment:
        missing.length === 0
          ? "used the expected tools"
          : `didn't use ${missing.join(", ")}`,
    };
  };

  return { task, evaluators: [correctness, rightTools] };
}

type Scored = {
  goldenId: string;
  output: unknown;
  evaluations: Evaluation[];
};

function scoresOf(evaluations: Evaluation[]): ItemScores {
  const value = (name: string) => {
    const found = evaluations.find((e) => e.name === name)?.value;
    return typeof found === "number" ? found : 0;
  };
  return {
    correctness: value("correctness"),
    rightTools: value("right_tools"),
  };
}

/** Every golden item's result in file order. One that never got scored counts as failed. */
function collect(scored: Scored[]): ItemResult[] {
  return GOLDEN_SET.items.map((golden) => {
    const result = scored.find((s) => s.goldenId === golden.id);
    if (!result) {
      return {
        id: golden.id,
        question: golden.question,
        answer: null,
        scores: { correctness: 0, rightTools: 0 },
        notes: ["not scored: the question failed before it was graded"],
      };
    }
    return {
      id: golden.id,
      question: golden.question,
      answer: (result.output as CopperAnswer | undefined) ?? null,
      scores: scoresOf(result.evaluations),
      notes: result.evaluations.map(
        (e) => `${e.name}: ${e.comment ?? String(e.value)}`,
      ),
    };
  });
}

const fromLangfuse = (
  result: ExperimentItemResult<GoldenInput, string, GoldenMetadata>,
): Scored => ({
  goldenId: (result.item.metadata as GoldenMetadata).goldenId,
  output: result.output,
  evaluations: result.evaluations,
});

/** The run-level score in Langfuse: the share of questions that passed. */
const passRate: RunEvaluator<GoldenInput, string, GoldenMetadata> = async ({
  itemResults,
}) => {
  const summary = summarize(
    collect(itemResults.map(fromLangfuse)).map((item) => item.scores),
  );
  return {
    name: "pass_rate",
    value: summary.passRate,
    comment: `${summary.passed} of ${summary.items} questions passed`,
  };
};

async function inLangfuse(options: RunOptions): Promise<GoldenRun> {
  const { task, evaluators } = evalSteps(
    options.retryDelaysMs ?? RETRY_DELAYS_MS,
  );
  const langfuse = startLangfuse();
  try {
    const data = await syncGoldenDataset(langfuse.client);
    const result = await langfuse.client.experiment.run<
      GoldenInput,
      string,
      GoldenMetadata
    >({
      name: EXPERIMENT_NAME,
      runName: options.runName,
      description:
        "Ask Copper (Copper and the Refund agent) on the golden set, graded by the AI judge.",
      metadata: options.metadata,
      data,
      task,
      evaluators,
      runEvaluators: [passRate],
      maxConcurrency: options.concurrency ?? 1,
    });
    const items = collect(result.itemResults.map(fromLangfuse));
    return {
      runName: result.runName,
      summary: summarize(items.map((item) => item.scores)),
      items,
      url: result.datasetRunUrl ?? result.experimentUrl,
    };
  } finally {
    await langfuse.stop();
  }
}

/** Runs `work` on every item, at most `limit` at a time, keeping their order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await work(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function onThisComputer(options: RunOptions): Promise<GoldenRun> {
  const { task, evaluators } = evalSteps(
    options.retryDelaysMs ?? RETRY_DELAYS_MS,
  );
  const scored = await mapWithLimit(
    GOLDEN_SET.items,
    options.concurrency ?? 1,
    async (golden): Promise<Scored> => {
      const item = toExperimentItem(golden);
      const output = await task(item);
      const evaluations: Evaluation[] = [];
      for (const evaluate of evaluators) {
        try {
          evaluations.push(...[await evaluate({ ...item, output })].flat());
        } catch (error) {
          // Like Langfuse: a score that fails is left out, so the item fails.
          console.warn(`[eval] ${golden.id}: a score failed`, error);
        }
      }
      return { goldenId: golden.id, output, evaluations };
    },
  );
  const items = collect(scored);
  return {
    runName: options.runName,
    summary: summarize(items.map((item) => item.scores)),
    items,
  };
}

export function runGoldenSet(options: RunOptions): Promise<GoldenRun> {
  return options.langfuse ? inLangfuse(options) : onThisComputer(options);
}

const percent = (x: number) => `${Math.round(x * 100)}%`;
const cell = (text: string) =>
  text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

/** The run as Markdown: printed in the log and shown on the GitHub Actions run page. */
export function formatReport(run: GoldenRun, minPassRate: number): string {
  const { summary } = run;
  const result = summary.passRate >= minPassRate ? "PASS" : "FAIL";
  const note = (item: ItemResult, name: string) =>
    item.notes.find((n) => n.startsWith(`${name}:`))?.slice(name.length + 1) ??
    "not scored";
  return [
    `### Golden-set eval: ${result}, ${summary.passed} of ${summary.items} questions passed (${percent(summary.passRate)}; needs ${percent(minPassRate)})`,
    "",
    `Run \`${run.runName}\` · judge score ${percent(summary.correctness)} · right tools ${percent(summary.toolAccuracy)}${run.url ? ` · [Open in Langfuse](${run.url})` : ""}`,
    "",
    "| | Question | Judge | Tools |",
    "| --- | --- | --- | --- |",
    ...run.items.map(
      (item) =>
        `| ${itemPassed(item.scores) ? "✅" : "❌"} | ${cell(item.id)} | ${cell(note(item, "correctness"))} | ${cell(note(item, "right_tools"))} |`,
    ),
  ].join("\n");
}
