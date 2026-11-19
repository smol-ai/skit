import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/check-frozen-migrations.test.mjs", "scripts/revision-migration.test.mjs"],
  },
});
