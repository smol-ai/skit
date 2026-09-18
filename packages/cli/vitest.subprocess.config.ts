import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/add-acquisition-lifetime.test.ts",
      "test/add-cli-lifetime.test.ts",
      "test/add-git-parity.test.ts",
      "test/application-cli.test.ts",
      "test/cli.test.ts",
      "test/declared-exit-codes.e2e.test.ts",
      "test/explicit-binding-command.test.ts",
      "test/harness-probe.test.ts",
      "test/native-probes.test.ts",
      "test/single-machine-journey.test.ts",
      "test/source-acquisition.test.ts",
    ],
    testTimeout: 30_000,
  },
});
