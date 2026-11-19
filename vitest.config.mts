import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
    // On a busy Windows laptop (antivirus, OneDrive), tests that start git
    // and Node processes can take longer than Vitest's default 5 seconds.
    testTimeout: 15_000,
  },
});
