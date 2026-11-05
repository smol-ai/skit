import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkCoreExports, checkFeatures } from "../scripts/check-structure.mjs";

const roots: string[] = [];
function fixture(files: string[]) {
  const root = mkdtempSync(join(tmpdir(), "skit-structure-check-"));
  roots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("declared feature layout", () => {
  const feature = "packages/skit/src/library/setup";
  test("one sibling entry with private implementations passes without build output", () => {
    const root = fixture([`${feature}.ts`, `${feature}/plan.ts`, `${feature}/undo/files.ts`]);
    expect(checkFeatures(root, [feature])).toEqual([]);
  });
  test("missing sibling and both duplicate entries are reported", () => {
    const root = fixture([`${feature}/index.ts`, `${feature}/setup.ts`]);
    expect(checkFeatures(root, [feature])).toEqual([
      `${feature}/: missing public entry ${feature}.ts`,
      `${feature}/index.ts: duplicate entry; use ${feature}.ts`,
      `${feature}/setup.ts: duplicate entry; use ${feature}.ts`,
    ]);
  });
  test("a deleted feature directory is detected even though Oxlint has no files to inspect", () => {
    const root = fixture([`${feature}.ts`]);
    expect(checkFeatures(root, [feature])).toEqual([`${feature}/: missing feature directory`]);
  });
});

describe("core exports and declared API roles", () => {
  const source = "packages/skit/src/library/setup.ts";
  const declarations = { "./library/setup": { kind: "owner", owners: ["Library"], source } };
  const sharedDeclarations = {
    "./library/setup": { kind: "shared", purpose: "Shared contract fixture.", source },
  };
  const owners = { Library: {} };
  const entry = { types: "./dist/library/setup.d.ts", import: "./dist/library/setup.js" };

  test.each(["owner", "shared"])("matching %s API targets pass without dist", (kind) => {
    const root = fixture([source]);
    expect(
      checkCoreExports(
        root,
        { exports: { "./library/setup": entry } },
        kind === "owner" ? declarations : sharedDeclarations,
        owners,
      ),
    ).toEqual([]);
  });
  test("new, removed and ownerless subpaths cannot silently change the public surface", () => {
    const root = fixture([source]);
    expect(
      checkCoreExports(root, { exports: { "./unknown": entry } }, declarations, owners),
    ).toEqual([
      "./unknown: no API declaration in architecture/app.ts coreExports",
      "./library/setup: declared in app.ts but absent from core exports",
    ]);
    expect(
      checkCoreExports(
        root,
        { exports: { "./library/setup": entry } },
        {
          "./library/setup": { kind: "owner", owners: [], source },
        },
        owners,
      ),
    ).toEqual(["./library/setup: must name at least one owner"]);
  });
  test("an unknown owner and missing source are both reported", () => {
    const root = fixture([]);
    expect(
      checkCoreExports(root, { exports: { "./library/setup": entry } }, declarations, {}),
    ).toEqual([
      "./library/setup: unknown owner Library",
      `./library/setup: missing source ${source}`,
    ]);
  });
  test.each(["owner", "shared"])("%s API conditions cannot expose a different module", (kind) => {
    const root = fixture([source]);
    const exports = {
      "./library/setup": {
        types: "./dist/library/setup/index.d.ts",
        node: { import: entry.import },
        default: "./dist/library/internal/writer.js",
      },
    };
    expect(
      checkCoreExports(
        root,
        { exports },
        kind === "owner" ? declarations : sharedDeclarations,
        owners,
      ),
    ).toEqual([
      "./library/setup (types): expected ./dist/library/setup.d.ts, got ./dist/library/setup/index.d.ts",
      "./library/setup (default): expected ./dist/library/setup.js, got ./dist/library/internal/writer.js",
    ]);
  });
  test.each(["owner", "shared"])(
    "invalid %s export target shapes fail rather than disappear",
    (kind) => {
      const root = fixture([source]);
      expect(() =>
        checkCoreExports(
          root,
          { exports: { "./library/setup": null } },
          kind === "owner" ? declarations : sharedDeclarations,
          owners,
        ),
      ).toThrow("Unsupported exports target");
    },
  );

  test("shared APIs require no invented owner", () => {
    const root = fixture([source]);
    expect(
      checkCoreExports(root, { exports: { "./library/setup": entry } }, sharedDeclarations, {}),
    ).toEqual([]);
  });
  test.each([
    { declaration: { source, owners: ["Library"] }, message: "API kind must be owner or shared" },
    { declaration: { kind: "other", source }, message: "API kind must be owner or shared" },
    { declaration: { kind: "owner", source }, message: "must name at least one owner" },
    { declaration: { kind: "shared", source }, message: "shared API must describe its purpose" },
    {
      declaration: { kind: "shared", source, purpose: "   " },
      message: "shared API must describe its purpose",
    },
    {
      declaration: { kind: "shared", source, purpose: "Contracts", owners: [] },
      message: "shared API must not declare state owners",
    },
    {
      declaration: { kind: "owner", source, owners: ["Library"], purpose: "Contracts" },
      message: "owner API must declare owners, not a shared purpose",
    },
  ])("invalid or mixed API roles fail: $message", ({ declaration, message }) => {
    const root = fixture([source]);
    expect(
      checkCoreExports(
        root,
        { exports: { "./library/setup": entry } },
        { "./library/setup": declaration },
        owners,
      ),
    ).toEqual([`./library/setup: ${message}`]);
  });
  test.each(["owner", "shared"])(
    "%s declarations still require their exact source file",
    (kind) => {
      const root = fixture([]);
      expect(
        checkCoreExports(
          root,
          { exports: { "./library/setup": entry } },
          kind === "owner" ? declarations : sharedDeclarations,
          owners,
        ),
      ).toEqual([`./library/setup: missing source ${source}`]);
    },
  );
});
