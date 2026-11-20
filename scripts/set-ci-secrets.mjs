// npm run ci:secrets: copies the keys CI's golden-set eval needs from
// .env.local into your GitHub repo's Actions secrets. Each value goes to gh
// on its input and is never printed. Run it again whenever a key changes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const SECRETS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

function fail(message) {
  console.error(`ci:secrets: ${message}`);
  process.exit(1);
}

// gh is an .exe on Windows, so it runs without a shell everywhere.
// Tests set CI_SECRETS_FAKE_GH to a Node script that stands in for gh.
function gh(args, input) {
  const fake = process.env.CI_SECRETS_FAKE_GH;
  const result = fake
    ? spawnSync(process.execPath, [fake, ...args], { input, encoding: "utf8" })
    : spawnSync("gh", args, { input, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    fail("install the GitHub CLI first: https://cli.github.com");
  }
  return result;
}

const file = process.argv[2] ?? ".env.local";
if (!existsSync(file)) {
  fail(`${file} not found. Add your keys to it first (see the README).`);
}
const env = parseEnv(readFileSync(file, "utf8"));

// Your repo is the "origin" remote (npm run start-module set it up).
const origin = spawnSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
});
const repo = (origin.stdout ?? "")
  .trim()
  .match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1];
if (!repo)
  fail('no GitHub "origin" remote: run this in your copper-mN folder.');

let problems = 0;
for (const name of SECRETS) {
  const value = env[name]?.trim();
  if (!value) {
    console.log(`skipped ${name}: it's empty or missing in ${file}`);
    problems++;
    continue;
  }
  const result = gh(["secret", "set", name, "--repo", repo], value);
  if (result.status === 0) {
    console.log(`set     ${name}`);
  } else {
    console.log(`failed  ${name}: ${(result.stderr || "gh failed").trim()}`);
    problems++;
  }
}

if (problems > 0) {
  fail(
    `${problems} of ${SECRETS.length} keys weren't set on ${repo}. Fix the lines above, then run npm run ci:secrets again.`,
  );
}
console.log(`Done: ${SECRETS.length} Actions secrets set on ${repo}.`);
