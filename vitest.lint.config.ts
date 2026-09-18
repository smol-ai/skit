import { defineConfig } from "vitest/config";

/** Repo-tooling tests. Package tests run from their own workspace projects. */
export default defineConfig({
  test: { include: ["lint/**/*.test.ts"] },
});
