// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askCopperOnce, type CopperAnswer } from "@/evals/ask";
import { GOLDEN_SET, type GoldenItem } from "@/evals/golden-set";
import { judgeAnswer } from "@/evals/judge";
import { formatReport, runGoldenSet } from "@/evals/run";
import { itemPassed, missingTools, summarize } from "@/evals/scoring";
import { TOOL_LABELS } from "@/lib/copper/assistant/progress";

// The golden-set eval with its model calls mocked: Ask Copper and the judge
// answer at once, so these tests check the eval itself, not the model.
// `npm run eval` runs it for real.
vi.mock("@/evals/ask", () => ({ askCopperOnce: vi.fn() }));
vi.mock("@/evals/judge", () => ({ judgeAnswer: vi.fn() }));

const ask = vi.mocked(askCopperOnce);
const judge = vi.mocked(judgeAnswer);
const ITEMS = GOLDEN_SET.items;

const golden = (question: string) =>
  ITEMS.find((item) => item.question === question)!;

/** The first tool of each expected entry, as if Copper used exactly those. */
const expectedTools = (item: GoldenItem) =>
  item.tools.map((entry) => entry.split("|")[0]);

const answer = (question: string, tools?: string[]): CopperAnswer => ({
  reply: `An answer to: ${question}`,
  agent: "copper",
  status: "done",
  tools: tools ?? expectedTools(golden(question)),
});

const failed: CopperAnswer = {
  reply: "Sorry, something went wrong on my end. Please try again.",
  agent: "copper",
  status: "error",
  tools: [],
};

beforeEach(() => {
  ask.mockReset();
  judge.mockReset();
  ask.mockImplementation(async ({ question }) => answer(question));
  judge.mockResolvedValue({ verdict: "correct", reason: "matches" });
});

const run = (retryDelaysMs: number[] = []) =>
  runGoldenSet({ runName: "test", langfuse: false, retryDelaysMs });

describe("Golden set", () => {
  it("has unique ids", () => {
    const ids = ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only Ask Copper's real tools", () => {
    for (const item of ITEMS) {
      for (const name of item.tools.flatMap((entry) => entry.split("|"))) {
        expect(TOOL_LABELS, `${item.id} uses ${name}`).toHaveProperty(name);
      }
    }
  });

  it("asks refund requests on the Support page", () => {
    const refunds = ITEMS.filter((item) =>
      item.tools.includes("request_refund"),
    );
    expect(refunds.length).toBeGreaterThan(0);
    for (const item of refunds) expect(item.support, item.id).toBe(true);
  });

  it("covers products, stock, costs, the documents, refunds and refusals", () => {
    const tools = ITEMS.flatMap((item) =>
      item.tools.flatMap((entry) => entry.split("|")),
    );
    for (const name of [
      "get_products",
      "check_availability",
      "calculate_cost",
      "search_docs",
      "request_refund",
    ]) {
      expect(tools).toContain(name);
    }
    expect(ITEMS.some((item) => item.tools.length === 0)).toBe(true);
  });
});

describe("Scoring", () => {
  it("accepts either tool of a|b", () => {
    expect(missingTools(["get_prices|get_products"], ["get_products"])).toEqual(
      [],
    );
  });

  it("lists the expected tools that weren't used", () => {
    expect(
      missingTools(
        ["transfer_to_refund_agent", "request_refund"],
        ["transfer_to_refund_agent"],
      ),
    ).toEqual(["request_refund"]);
  });

  it("passes an item only when it's correct and used the right tools", () => {
    expect(itemPassed({ correctness: 1, rightTools: 1 })).toBe(true);
    expect(itemPassed({ correctness: 0.5, rightTools: 1 })).toBe(false);
    expect(itemPassed({ correctness: 1, rightTools: 0 })).toBe(false);
  });

  it("sums up the pass rate, judge score and tool accuracy", () => {
    expect(
      summarize([
        { correctness: 1, rightTools: 1 },
        { correctness: 0.5, rightTools: 1 },
        { correctness: 0, rightTools: 0 },
        { correctness: 1, rightTools: 1 },
      ]),
    ).toEqual({
      items: 4,
      passed: 2,
      passRate: 0.5,
      correctness: 0.625,
      toolAccuracy: 0.75,
    });
  });
});

describe("Golden-set run (model calls mocked)", () => {
  it("asks every question and passes when every answer is right", async () => {
    const result = await run();
    expect(ask).toHaveBeenCalledTimes(ITEMS.length);
    expect(result.items.map((item) => item.id)).toEqual(
      ITEMS.map((item) => item.id),
    );
    expect(result.summary.passRate).toBe(1);
    expect(formatReport(result, 0.8)).toContain(
      `PASS, ${ITEMS.length} of ${ITEMS.length} questions passed`,
    );
  });

  it("asks Support-page questions with the refund desk", async () => {
    await run();
    const refund = ITEMS.find((item) => item.support)!;
    expect(ask).toHaveBeenCalledWith({
      question: refund.question,
      support: true,
    });
  });

  it("fails answers the judge marks wrong and answers that skip a tool", async () => {
    const [first, second] = ITEMS;
    judge.mockImplementation(async ({ question }) =>
      question === first.question
        ? { verdict: "incorrect", reason: "wrong colors" }
        : { verdict: "correct", reason: "matches" },
    );
    ask.mockImplementation(async ({ question }) =>
      answer(question, question === second.question ? [] : undefined),
    );

    const result = await run();
    expect(result.summary.passed).toBe(ITEMS.length - 2);
    expect(result.items[0].notes).toContain(
      "correctness: incorrect: wrong colors",
    );
    expect(result.items[1].notes.join(" ")).toContain("didn't use");
    expect(formatReport(result, 1)).toContain("FAIL");
  });

  it("asks again when Ask Copper fails once", async () => {
    const first = ITEMS[0];
    let failures = 0;
    ask.mockImplementation(async ({ question }) =>
      question === first.question && failures++ === 0
        ? failed
        : answer(question),
    );

    const result = await run([0]);
    expect(ask).toHaveBeenCalledTimes(ITEMS.length + 1);
    expect(result.summary.passRate).toBe(1);
  });

  it("fails a question that keeps failing, without judging it", async () => {
    const first = ITEMS[0];
    ask.mockImplementation(async ({ question }) =>
      question === first.question ? failed : answer(question),
    );

    const result = await run([0]);
    expect(result.items[0].scores.correctness).toBe(0);
    expect(judge).not.toHaveBeenCalledWith(
      expect.objectContaining({ question: first.question }),
    );
    expect(result.summary.passed).toBe(ITEMS.length - 1);
  });
});

describe("CI runs every check before a merge into main", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));

  it("runs on pull requests into main", () => {
    expect(ci).toMatch(/pull_request:\s+branches: \[main\]/);
  });

  it("runs lint, typecheck, the tests and the build", () => {
    for (const step of [
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]) {
      expect(ci).toContain(`run: ${step}`);
    }
  });

  it("runs the golden-set eval once the tests pass", () => {
    expect(ci).toContain("name: Golden-set eval");
    expect(ci).toMatch(/needs: check/);
    expect(ci).toContain("run: npm run eval");
    expect(scripts.eval).toBe("vitest run --config vitest.eval.config.mts");
  });

  it("gives the eval its keys from the repo's Actions secrets", () => {
    for (const name of [
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "LANGFUSE_PUBLIC_KEY",
      "LANGFUSE_SECRET_KEY",
      "LANGFUSE_BASE_URL",
    ]) {
      expect(ci).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    expect(scripts["ci:secrets"]).toBe("node scripts/set-ci-secrets.mjs");
  });
});
