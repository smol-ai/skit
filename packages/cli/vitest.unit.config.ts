import authorSyncConfig from "./vitest.author-sync.config.js";
import subprocessConfig from "./vitest.subprocess.config.js";
import { defineConfig } from "vitest/config";

const subprocessTests = subprocessConfig.test?.include ?? [];
const authorSyncTests = authorSyncConfig.test?.include ?? [];

export default defineConfig({
  test: {
    exclude: [...subprocessTests, ...authorSyncTests, "test/git-revision-sync.test.ts"],
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../vitest.isolated-home.ts"],
    testTimeout: 30_000,
  },
});
