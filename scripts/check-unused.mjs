import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { declarationUses, hasIssues, remainingIssues } from "./declaration-uses.mjs";

const root = resolve(import.meta.dirname, "..");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.signal)
    throw result.error ?? new Error(`${command} terminated: ${result.signal}`);
  return result;
};
const compile = (config, args) => {
  const local = join(root, config.split("/").slice(0, -1).join("/"), "node_modules/.bin/tsc");
  const result = run(existsSync(local) ? local : join(root, "node_modules/.bin/tsc"), args);
  if (result.status !== 0)
    throw new Error(
      `Declaration compilation failed for ${config}\n${result.stdout}${result.stderr}`,
    );
  return result.stdout;
};
const configs = [];
try {
  const knip = run(join(root, "node_modules/.bin/knip"), ["--reporter", "json", "--no-progress"]);
  if (knip.status !== 0 && knip.status !== 1) throw new Error(`Knip failed: ${knip.stderr}`);
  const report = JSON.parse(knip.stdout);
  let remaining = report;
  if (report.issues.some((issue) => issue.types.length)) {
    const manifest = JSON.parse(readFileSync(join(root, "packages/skit/package.json"), "utf8"));
    const entries = new Map(
      Object.entries(manifest.exports).map(([name, entry]) => [
        `${manifest.name}${name.slice(1)}`,
        join(
          root,
          "packages/skit/src",
          entry.types.replace(/^\.\/dist\//, "").replace(/\.d\.ts$/, ".ts"),
        ),
      ]),
    );
    const projects = [];
    for (const [name, config] of [
      ["core", "packages/skit/tsconfig.typecheck.json"],
      ["cli", "packages/cli/tsconfig.json"],
      ["server", "packages/skit-server-effect/tsconfig.json"],
    ]) {
      const effective = JSON.parse(compile(config, ["-p", join(root, config), "--showConfig"]));
      const source = resolve(root, config, "..", effective.compilerOptions.rootDir);
      // Keep config resolution beside the original package (not /tmp), so ambient
      // type directives and emitted imports resolve package dependencies normally.
      // Both config and declarations are fresh and removed in finally; dist is untouched.
      const configDirectory = mkdtempSync(join(root, dirname(config), ".unused-"));
      configs.push(configDirectory);
      const output = join(configDirectory, "declarations");
      const temporaryConfig = join(configDirectory, "tsconfig.json");
      const paths = Object.fromEntries(
        [...entries].map(([specifier, source]) => [
          specifier,
          [
            join(
              projects[0]?.output ?? output,
              relative(join(root, "packages/skit"), source).replace(/\.ts$/, ".d.ts"),
            ),
          ],
        ]),
      );
      writeFileSync(
        temporaryConfig,
        JSON.stringify({
          extends: join(root, config),
          compilerOptions: {
            outDir: output,
            noEmit: false,
            emitDeclarationOnly: true,
            incremental: false,
            ...(name === "core" ? {} : { paths }),
          },
        }),
      );
      compile(config, ["-p", temporaryConfig]);
      projects.push({ source, output });
    }
    remaining = remainingIssues(report, declarationUses(projects, entries), root);
    const count = (value) => value.issues.reduce((sum, issue) => sum + issue.types.length, 0);
    console.log(
      `Declaration references account for ${count(report) - count(remaining)} type findings.`,
    );
  }
  if (hasIssues(remaining)) {
    console.error(JSON.stringify(remaining, null, 2));
    process.exitCode = 1;
  } else console.log("No unused files, exports, types, duplicates or cycles.");
} finally {
  for (const directory of configs) rmSync(directory, { recursive: true, force: true });
}
