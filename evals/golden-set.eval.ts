// npm run eval: the golden-set eval (Module 5). Ask Copper answers every
// question in evals/golden-set.json, the AI judge grades each answer, and the
// eval fails when fewer than EVAL_MIN_PASS_RATE (80%) of them pass. CI runs it
// on every pull request into main once the tests pass. With the Langfuse keys
// set, each run and its scores are kept in Langfuse.
import { appendFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isAiConfigured } from "@/lib/ai/call";
import { defaultModel } from "@/lib/ai/models";
import { modelKeyProblem } from "./key-check";
import { isLangfuseConfigured } from "./langfuse";
import { formatReport, runGoldenSet } from "./run";
import type { Agents } from "./scoring";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const MIN_PASS_RATE = Number(process.env.EVAL_MIN_PASS_RATE || 0.8);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 1);
const inCi = Boolean(process.env.CI);
// Module 5: EVAL_AGENTS=one asks one support agent that does everything
// instead of the site's two agents, to compare them in Langfuse.
const AGENTS: Agents = process.env.EVAL_AGENTS === "one" ? "one" : "two";

/** Names the run after the pull request and commit in CI, or the time here. */
function runName(): string {
  const sha = process.env.EVAL_SHA?.slice(0, 7);
  if (process.env.EVAL_PR && sha) return `pr-${process.env.EVAL_PR}-${sha}`;
  if (sha) return `${process.env.GITHUB_REF_NAME || "ci"}-${sha}`;
  return `local-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
}

describe("Golden-set eval", () => {
  // Here it needs a Google key in .env.local and is skipped without one.
  // In CI a missing key fails it, so a pull request can't skip the eval.
  it.skipIf(!inCi && !isAiConfigured())(
    `Ask Copper passes at least ${MIN_PASS_RATE * 100}% of the golden set`,
    async () => {
      const missing = [
        !isAiConfigured() && "GOOGLE_GENERATIVE_AI_API_KEY",
        inCi &&
          !isLangfuseConfigured() &&
          "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
      ].filter((name): name is string => Boolean(name));
      expect(
        missing,
        "Missing keys: add them to .env.local, then run npm run ci:secrets",
      ).toEqual([]);
      expect(
        await modelKeyProblem(),
        "Google won't answer with GOOGLE_GENERATIVE_AI_API_KEY (the reason is below). A daily limit resets at midnight Pacific time, or use another model with AI_MODEL; a wrong key: fix it in .env.local, then run npm run ci:secrets",
      ).toBeNull();

      const run = await runGoldenSet({
        runName: AGENTS === "one" ? `${runName()}-one-agent` : runName(),
        concurrency: CONCURRENCY,
        langfuse: isLangfuseConfigured(),
        agents: AGENTS,
        metadata: {
          model: defaultModel(),
          agents:
            AGENTS === "one" ? "one support agent" : "Copper + Refund agent",
          pr: process.env.EVAL_PR || null,
          commit: process.env.EVAL_SHA || null,
        },
      });
      const report = formatReport(run, MIN_PASS_RATE);
      console.log(report);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
      }
      expect(
        run.summary.passRate,
        "share of golden-set questions that passed",
      ).toBeGreaterThanOrEqual(MIN_PASS_RATE);
    },
  );
});
