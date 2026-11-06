import { defineConfig } from "vitest/config";

/** Repo-tooling tests. Package tests run from their own workspace projects. */
export default defineConfig({
  test: {
    // Type-aware rules build the CLI program on first use; the default 5s is not enough under load.
    testTimeout: 30_000,
    include: ["lint/**/*.test.ts"],
  },
});
