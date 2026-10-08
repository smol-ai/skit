import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/full-collections.e2e.ts"],
    setupFiles: ["../../vitest.isolated-home.ts"],
    testTimeout: 300_000,
  },
});
