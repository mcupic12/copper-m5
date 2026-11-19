// npm run eval runs only the golden-set eval (evals/*.eval.ts), never the
// unit tests, with time for real model calls.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 60_000,
  },
});
