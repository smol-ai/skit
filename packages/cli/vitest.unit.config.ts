import subprocessConfig from "./vitest.subprocess.config.js";
import { defineConfig } from "vitest/config";

const subprocessTests = subprocessConfig.test?.include ?? [];

export default defineConfig({
  test: {
    exclude: [...subprocessTests, "test/git-revision-sync.test.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
