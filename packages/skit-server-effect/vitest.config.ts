import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.test.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e.test.ts", "test/e2e-skills-sh.test.ts"],
    maxWorkers: 1,
  },
}));
