// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  EVALUATOR_NAME,
  JUDGE_PROMPT,
  RULE_NAME,
  setupLangfuseJudge,
  VARIABLE_MAPPING,
} from "../scripts/setup-langfuse-judge.mjs";

type Named = { id: string; name: string };
type FakeOptions = {
  connections?: { provider: string; adapter: string }[];
  evaluators?: Named[];
  rules?: Named[];
  dataset?: { id: string } | null;
};

// A stand-in for the Langfuse client that records what the script creates,
// so these tests never touch the real Langfuse project.
function fakeLangfuse({
  connections = [{ provider: "google-ai-studio", adapter: "google-ai-studio" }],
  evaluators = [],
  rules = [],
  dataset = { id: "dataset-1" },
}: FakeOptions = {}) {
  return {
    api: {
      llmConnections: { list: vi.fn(async () => ({ data: connections })) },
      datasets: {
        get: vi.fn(async () => {
          if (!dataset)
            throw Object.assign(new Error("Not found"), { statusCode: 404 });
          return dataset;
        }),
      },
      evaluators: {
        list: vi.fn(async () => ({ data: evaluators })),
        create: vi.fn(async (body: Record<string, unknown>) => ({
          id: "evaluator-new",
          ...body,
        })),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          id,
          ...body,
        })),
      },
      evaluationRules: {
        list: vi.fn(async () => ({ data: rules })),
        create: vi.fn(async (body: Record<string, unknown>) => ({
          id: "rule-new",
          ...body,
        })),
        update: vi.fn(async (id: string, body: Record<string, unknown>) => ({
          id,
          ...body,
        })),
      },
    },
  };
}

const quiet = { log: () => {} };

describe("npm run langfuse:judge", () => {
  it("creates an LLM-as-a-Judge evaluator on the Google connection", async () => {
    const client = fakeLangfuse();
    await setupLangfuseJudge(client, quiet);
    expect(client.api.evaluators.create.mock.calls[0][0]).toMatchObject({
      name: EVALUATOR_NAME,
      type: "llm_as_judge",
      modelConfig: {
        provider: "google-ai-studio",
        model: "gemini-3.5-flash-lite",
      },
      outputDefinition: { dataType: "NUMERIC", minValue: 0, maxValue: 1 },
    });
  });

  it("gives the judge the question, Copper's reply and the expected answer", () => {
    for (const name of ["input", "output", "expected_output"]) {
      expect(JUDGE_PROMPT).toContain(`{{${name}}}`);
      expect(VARIABLE_MAPPING.map((m) => m.variable)).toContain(name);
    }
    expect(VARIABLE_MAPPING).toContainEqual({
      variable: "output",
      source: "output",
      jsonPath: "$.reply",
    });
  });

  it("runs the judge on every golden-set run, once per question", async () => {
    const client = fakeLangfuse();
    await setupLangfuseJudge(client, quiet);
    const rule = client.api.evaluationRules.create.mock.calls[0][0];
    expect(rule).toMatchObject({
      name: RULE_NAME,
      enabled: true,
      sampling: 1,
      evaluatorAssignments: [{ evaluatorId: "evaluator-new" }],
    });
    expect(rule.filter).toContainEqual({
      type: "stringOptions",
      column: "datasetId",
      operator: "any of",
      value: ["dataset-1"],
    });
    expect(rule.filter).toContainEqual({
      type: "boolean",
      column: "isRootObservation",
      operator: "=",
      value: true,
    });
  });

  it("updates the evaluator and rule instead of making copies", async () => {
    const client = fakeLangfuse({
      evaluators: [{ id: "evaluator-1", name: EVALUATOR_NAME }],
      rules: [{ id: "rule-1", name: RULE_NAME }],
    });
    await setupLangfuseJudge(client, quiet);
    expect(client.api.evaluators.create).not.toHaveBeenCalled();
    expect(client.api.evaluators.update.mock.calls[0][0]).toBe("evaluator-1");
    expect(client.api.evaluationRules.create).not.toHaveBeenCalled();
    expect(client.api.evaluationRules.update.mock.calls[0][0]).toBe("rule-1");
  });

  it("says to add an LLM connection in Langfuse first", async () => {
    await expect(
      setupLangfuseJudge(fakeLangfuse({ connections: [] }), quiet),
    ).rejects.toThrow(/LLM Connections/);
  });

  it("says to run the eval first when the dataset doesn't exist yet", async () => {
    await expect(
      setupLangfuseJudge(fakeLangfuse({ dataset: null }), quiet),
    ).rejects.toThrow(/npm run eval/);
  });
});
