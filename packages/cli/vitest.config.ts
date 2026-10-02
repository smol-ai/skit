import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../test-support/isolated-home.ts"],
    testTimeout: 30_000,
  },
});
