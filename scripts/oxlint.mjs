#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// One entry point for CLI and editor linting, without patching pnpm's installed packages.
const cli = new URL("dist/effect-tsgo.cjs", import.meta.resolve("@effect/tsgo/package.json"));
const result = spawnSync(
  process.execPath,
  [fileURLToPath(cli), "oxlint", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
