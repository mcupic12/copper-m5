// How the golden-set eval scores Ask Copper (Module 5). Pure functions, so
// the tests check them without calling a model.

/** The AI judge's verdicts, and the score each one is worth. */
export const VERDICT_SCORES = {
  correct: 1,
  partly_correct: 0.5,
  incorrect: 0,
} as const;

export type Verdict = keyof typeof VERDICT_SCORES;

/** The expected tools the answer didn't use. "a|b" is met by either one. */
export function missingTools(expected: string[], used: string[]): string[] {
  return expected.filter(
    (entry) => !entry.split("|").some((name) => used.includes(name.trim())),
  );
}

/** One item's two scores, as Langfuse records them. */
export type ItemScores = {
  /** The judge's verdict: 1 correct, 0.5 partly correct, 0 incorrect. */
  correctness: number;
  /** 1 when the answer used every expected tool, else 0. */
  rightTools: number;
};

/** An item passes when the judge says it's correct and it used the right tools. */
export const itemPassed = (scores: ItemScores) =>
  scores.correctness === 1 && scores.rightTools === 1;

export type Summary = {
  items: number;
  passed: number;
  /** Share of items that passed: what CI checks. */
  passRate: number;
  /** Average judge score. */
  correctness: number;
  /** Share of items that used the expected tools. */
  toolAccuracy: number;
};

const round = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(scores: ItemScores[]): Summary {
  const n = scores.length;
  const share = (total: number) => (n === 0 ? 0 : round(total / n));
  const passed = scores.filter(itemPassed).length;
  return {
    items: n,
    passed,
    passRate: share(passed),
    correctness: share(scores.reduce((sum, s) => sum + s.correctness, 0)),
    toolAccuracy: share(scores.reduce((sum, s) => sum + s.rightTools, 0)),
  };
}
