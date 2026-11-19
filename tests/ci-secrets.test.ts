// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/temp-dir";

const script = join(process.cwd(), "scripts/set-ci-secrets.mjs");

const KEYS = {
  GOOGLE_GENERATIVE_AI_API_KEY: "AIza-test-google-key-0123456789",
  LANGFUSE_PUBLIC_KEY: "pk-lf-test-public-key",
  LANGFUSE_SECRET_KEY: "sk-lf-test-secret-key",
  LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
};

const envFile = (keys: Record<string, string>) =>
  Object.entries(keys)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

// A folder whose "origin" is the student's repo, with a .env.local, and a
// fake `gh` (a Node script) that records each call and what it got on its
// input instead of talking to GitHub.
function run(env: string | null) {
  const dir = tempDir("ci-secrets-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/student/copper-m5.git"],
    { cwd: dir },
  );
  if (env !== null) writeFileSync(join(dir, ".env.local"), env);
  const log = join(dir, "gh.log");
  const fakeGh = join(dir, "fake-gh.mjs");
  writeFileSync(
    fakeGh,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, "utf8") }) + "\\n");`,
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CI_SECRETS_FAKE_GH: fakeGh },
  });
  const calls: { args: string[]; input: string }[] = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    status: result.status,
    calls,
    output: result.stdout + result.stderr,
  };
}

describe("npm run ci:secrets", () => {
  it("sets each eval key as an Actions secret on the origin repo", () => {
    const { status, calls } = run(
      envFile({ ...KEYS, OTHER_KEY: "not-for-ci" }),
    );
    expect(status).toBe(0);
    expect(calls.map((call) => call.args)).toEqual(
      Object.keys(KEYS).map((name) => [
        "secret",
        "set",
        name,
        "--repo",
        "student/copper-m5",
      ]),
    );
    expect(calls.map((call) => call.input)).toEqual(Object.values(KEYS));
  });

  it("never prints a key", () => {
    const { output } = run(envFile(KEYS));
    for (const value of Object.values(KEYS)) {
      expect(output).not.toContain(value);
    }
  });

  it("stops and names the keys missing from .env.local", () => {
    const { status, calls, output } = run(
      envFile({
        GOOGLE_GENERATIVE_AI_API_KEY: KEYS.GOOGLE_GENERATIVE_AI_API_KEY,
        LANGFUSE_PUBLIC_KEY: "",
      }),
    );
    expect(status).toBe(1);
    expect(calls).toHaveLength(1);
    expect(output).toContain("skipped LANGFUSE_PUBLIC_KEY");
    expect(output).toContain("skipped LANGFUSE_SECRET_KEY");
  });

  it("says what to do when .env.local is missing", () => {
    const { status, calls, output } = run(null);
    expect(status).toBe(1);
    expect(calls).toEqual([]);
    expect(output).toContain(".env.local not found");
  });
});
