import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript-parser";
import { afterEach, expect, test } from "vitest";
import { declarationUses, hasIssues, remainingIssues } from "../scripts/declaration-uses.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "skit-declaration-test-"));
  roots.push(root);
  const source = join(root, "src"),
    output = join(root, "declarations");
  mkdirSync(source);
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(source, name), contents);
  const program = ts.createProgram(
    Object.keys(files).map((name) => join(source, name)),
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      rootDir: source,
      outDir: output,
      declaration: true,
      emitDeclarationOnly: true,
      strict: true,
      skipLibCheck: true,
      types: [],
    },
  );
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
  ).toEqual([]);
  expect(program.emit().emitSkipped).toBe(false);
  return { root, source, output };
}

// The declarations below come from a compiler, not a hand-written imitation of its output.
test("inferred foreign types count, while exported but unused types still fail", () => {
  const project = fixture({
    "owner.ts":
      'export type Needed = { readonly value: string }; export type Dead = { readonly unused: true }; export const create = (): Needed => ({ value: "ok" });',
    "consumer.ts": 'import { create } from "./owner.js"; export const run = () => create();',
  });
  const report = {
    issues: [
      {
        file: "src/owner.ts",
        types: [{ name: "Needed" }, { name: "Dead" }],
        exports: [],
        files: [],
        cycles: [],
      },
    ],
  };
  const remaining = remainingIssues(report, declarationUses([project]), project.root);
  expect(remaining.issues[0].types).toEqual([{ name: "Dead" }]);
  expect(hasIssues(remaining)).toBe(true);
  expect(report.issues[0].types).toHaveLength(2);
});

test("referenced aliases and namespace imports resolve without counting unused re-exports", () => {
  const project = fixture({
    "owner.ts":
      "export type Needed = { readonly value: string }; export type Dead = { readonly unused: true };",
    "entry.ts": 'export type { Needed as Public, Dead } from "./owner.js";',
    "consumer.ts":
      'import type * as Owner from "./entry.js"; export declare const run: () => Owner.Public;',
  });
  const issue = (file: string, names: string[]) => ({
    file,
    types: names.map((name) => ({ name })),
    exports: [],
    files: [],
    cycles: [],
  });
  const report = {
    issues: [issue("src/owner.ts", ["Needed", "Dead"]), issue("src/entry.ts", ["Public", "Dead"])],
  };
  const remaining = remainingIssues(report, declarationUses([project]), project.root);
  expect(remaining.issues.map((row: { types: { name: string }[] }) => row.types)).toEqual([
    [{ name: "Dead" }],
    [{ name: "Dead" }],
  ]);
});

test("stale declarations cannot rescue a type; other Knip findings remain failures", () => {
  const project = fixture({ "owner.ts": "export type Dead = string;" });
  writeFileSync(
    join(project.output, "deleted.d.ts"),
    'export declare const stale: import("./owner.js").Dead;',
  );
  const report = {
    issues: [
      {
        file: "src/owner.ts",
        types: [{ name: "Dead" }],
        exports: [{ name: "unusedValue" }],
        files: [{ name: "unused.ts" }],
        duplicates: [[{ name: "duplicate" }]],
        cycles: [[{ name: "cycle" }]],
      },
    ],
  };
  expect(remainingIssues(report, declarationUses([project]), project.root)).toEqual(report);
  for (const field of ["exports", "files", "duplicates", "cycles"] as const) {
    expect(
      hasIssues({
        issues: [{ file: "src/owner.ts", types: [], [field]: report.issues[0][field] }],
      }),
    ).toBe(true);
  }
  expect(hasIssues({ issues: [] })).toBe(false);
});
