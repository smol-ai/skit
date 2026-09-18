import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/live-sources.e2e.ts"],
    testTimeout: 300_000,
  },
});
