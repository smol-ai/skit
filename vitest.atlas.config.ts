import { defineConfig } from "vitest/config";

// Offline suites only. Live and cached-source checks use separate opt-in entrypoints.
export default defineConfig({
  test: {
    projects: ["cli", "skit"].map((name) => ({
      test: {
        name,
        root: new URL(`./packages/${name}/`, import.meta.url).pathname,
        include: ["test/**/*.test.ts"],
        exclude: ["test/fixtures/**", "**/node_modules/**"],
        setupFiles: ["../../vitest.isolated-home.ts"],
        testTimeout: 30_000,
      },
    })),
  },
});
