import { defineConfig } from "vitest/config";

/** Offline lane: fixtures and the verifier, driven by skit directly. No agent, no model usage. */
export default defineConfig({
  test: {
    include: ["test/**/*.control.test.ts"],
    testTimeout: 60_000,
  },
});
