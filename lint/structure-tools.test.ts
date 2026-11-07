import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const knip = fileURLToPath(new URL("../bin/knip.js", import.meta.resolve("knip")));
const directories: string[] = [];

function fixture(files: { [path: string]: string }): string {
  const directory = mkdtempSync(join(tmpdir(), "skit-structure-"));
  directories.push(directory);
  for (const [path, source] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("structure tooling", () => {
  test("Knip traces workspace package exports back to source and checks private entry exports", () => {
    const directory = fixture({
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/skit/package.json": JSON.stringify({
        name: "@smolai/skit-core",
        private: true,
        exports: { "./library": "./dist/library/index.js" },
      }),
      "packages/skit/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist" },
      }),
      "packages/skit/src/library/index.ts": "export const used = 1; export const unusedEntry = 2;",
      "packages/cli/package.json": JSON.stringify({
        name: "@smolai/skit",
        dependencies: { "@smolai/skit-core": "workspace:*" },
        exports: { "./storybook": "./dist/src/storybook/index.js" },
      }),
      "packages/cli/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: ".", outDir: "dist" },
      }),
      "packages/cli/src/main.ts":
        'import { used } from "@smolai/skit-core/library"; console.log(used);',
      "packages/cli/src/storybook/index.ts": "export const published = 1;",
      "packages/skit-server-effect/package.json": JSON.stringify({
        name: "@smolai/skit-server-effect",
        private: true,
        devDependencies: { vite: "*", vitest: "*" },
      }),
      // Linting must not execute build or Cloudflare test setup.
      "packages/skit-server-effect/vite.config.ts": 'throw new Error("build setup executed");',
      "packages/skit-server-effect/vitest.config.ts":
        'throw new Error("Cloudflare setup executed");',
      "packages/skit-server-effect/src/index.ts": "console.log('worker');",
      "packages/skit-server-effect/web/src/entry.ts": "console.log('web');",
    });
    copyFileSync(join(root, "knip.jsonc"), join(directory, "knip.jsonc"));
    const result = spawnSync(process.execPath, [knip, "--reporter", "json", "--no-progress"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    const findings = report.issues.flatMap(
      (issue: { exports: Array<{ name: string }> }) => issue.exports,
    );
    expect(findings.map((item: { name: string }) => item.name)).toEqual(["unusedEntry"]);
    expect(report.issues.some((issue: { files: unknown[] }) => issue.files.length > 0)).toBe(false);
  });

  test("Knip rejects a real value-import cycle", () => {
    const directory = fixture({
      "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      "packages/skit/package.json": JSON.stringify({
        name: "@smolai/skit-core",
        private: true,
        exports: { "./library": "./dist/library/index.js" },
      }),
      "packages/skit/tsconfig.json": JSON.stringify({
        compilerOptions: { rootDir: "src", outDir: "dist" },
      }),
      "packages/skit/src/library/index.ts":
        'import { next } from "./next.js"; export const first = () => next();',
      "packages/skit/src/library/next.ts":
        'import { first } from "./index.js"; export const next = () => first();',
    });
    copyFileSync(join(root, "knip.jsonc"), join(directory, "knip.jsonc"));
    const result = spawnSync(
      process.execPath,
      [knip, "--include", "cycles", "--reporter", "json", "--no-progress"],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.issues.flatMap((issue: { cycles: unknown[] }) => issue.cycles)).toHaveLength(1);
  });

  test("Oxlint's configured graph check rejects a large wildcard barrel and accepts named exports", () => {
    // One direct re-export with a deep import graph needs the import plugin to be detected.
    const files: { [path: string]: string } = {
      "barrel.ts": 'export * from "./module0.js";',
      "named.ts": 'export { value } from "./module0.js";',
    };
    for (let index = 0; index < 102; index++) {
      files[`module${index}.ts`] =
        index === 101
          ? "export const value = 1;"
          : `import { value as next } from "./module${index + 1}.js"; export const value = next;`;
    }
    const directory = fixture(files);
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    const result = spawnSync(
      process.execPath,
      [
        join(root, "scripts/oxlint.mjs"),
        "--config",
        join(root, ".oxlintrc.json"),
        "--format=json",
        "barrel.ts",
        "named.ts",
      ],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    const findings = report.diagnostics.filter(
      (item: { code: string }) => item.code === "oxc(no-barrel-file)",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].filename).toBe("barrel.ts");
  });
});
