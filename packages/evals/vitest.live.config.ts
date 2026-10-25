import { defineConfig } from "vitest/config";

/** Live lane: drives a real Codex turn per case. Costs model usage; never part of `pnpm test`. */
export default defineConfig({
  test: {
    include: ["test/**/*.live.test.ts"],
    testTimeout: 900_000,
    fileParallelism: false,
  },
});
