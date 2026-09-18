import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e.test.ts", "test/e2e-skills-sh.test.ts"],
    testTimeout: 180_000,
  },
});
