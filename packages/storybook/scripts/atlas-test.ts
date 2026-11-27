import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { testSource } from "../src/atlas/test-source.ts";

const [project, ...filters] = process.argv.slice(2);
if (project !== "cli" && project !== "skit") throw new Error("Expected the cli or skit project");

const root = resolve(import.meta.dirname, "../../..");
const directory = resolve(root, "packages", project, ".atlas");
mkdirSync(directory, { recursive: true });
const temporary = mkdtempSync(resolve(directory, "run-"));
try {
  const report = resolve(temporary, "vitest.json");
  const source = testSource(root);
  const run = spawnSync(
    "vitest",
    [
      "run",
      "--config",
      "../../vitest.atlas.config.ts",
      "--project",
      project,
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`,
      ...filters,
    ],
    { cwd: resolve(root, "packages", project), stdio: "inherit" },
  );
  if (run.error) throw run.error;
  if (run.signal) throw new Error(`Vitest exited on ${run.signal}`);
  const result = JSON.parse(readFileSync(report, "utf8"));
  const after = testSource(root);
  result.source = {
    ...source,
    dirty: source.dirty || after.dirty || source.revision !== after.revision,
  };
  writeFileSync(report, JSON.stringify(result));
  renameSync(report, resolve(directory, "vitest.json"));
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
