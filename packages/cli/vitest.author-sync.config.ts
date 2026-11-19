import { defineConfig } from "vitest/config";

// Two-device sync worlds and live file watchers on the real disk. They run one file at a time,
// apart from the unit files, so load from the rest of the suite cannot slow them into failing.
export default defineConfig({
  test: {
    include: ["test/author-sync-world.test.ts", "test/scenario-sets.test.ts"],
    setupFiles: ["../../vitest.isolated-home.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
