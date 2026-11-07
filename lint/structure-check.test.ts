import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkCoreExports } from "../scripts/check-structure.mjs";

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

describe("core export map used by lint", () => {
  const source = "packages/skit/src/library/setup.ts";
  const declarations = { "./library/setup": { source } };
  const entry = { types: "./dist/library/setup.d.ts", import: "./dist/library/setup.js" };

  test.each(["main", "types"])("core cannot regain a %s root fallback", (field) => {
    const root = fixture([source]);
    expect(
      checkCoreExports(
        root,
        { [field]: entry.import, exports: { "./library/setup": entry } },
        declarations,
      ),
    ).toEqual([`core package.json: ${field} fallback is forbidden; use declared subpath exports`]);
  });

  test("a root export is rejected even if present in the lint map", () => {
    const root = fixture([source]);
    expect(
      checkCoreExports(
        root,
        { exports: { ".": entry, "./library/setup": entry } },
        { ...declarations, ".": declarations["./library/setup"] },
      ),
    ).toEqual([".: core root export is forbidden; use declared subpaths"]);
  });

  test("an unexported root source file is still rejected", () => {
    const root = fixture([source, "packages/skit/src/index.ts"]);
    expect(checkCoreExports(root, { exports: { "./library/setup": entry } }, declarations)).toEqual(
      ["packages/skit/src/index.ts: core root entry is forbidden"],
    );
  });

  test("matching export targets pass without dist", () => {
    const root = fixture([source]);
    expect(checkCoreExports(root, { exports: { "./library/setup": entry } }, declarations)).toEqual(
      [],
    );
  });

  test("new and removed subpaths cannot silently change the surface lint checks", () => {
    const root = fixture([source]);
    expect(checkCoreExports(root, { exports: { "./unknown": entry } }, declarations)).toEqual([
      "./unknown: no API declaration in architecture/exports.mjs coreExports",
      "./library/setup: declared in exports.mjs but absent from core exports",
    ]);
  });

  test("export conditions cannot expose a different module", () => {
    const root = fixture([source]);
    const exports = {
      "./library/setup": {
        types: "./dist/library/setup/index.d.ts",
        node: { import: entry.import },
        default: "./dist/library/internal/writer.js",
      },
    };
    expect(checkCoreExports(root, { exports }, declarations)).toEqual([
      "./library/setup (types): expected ./dist/library/setup.d.ts, got ./dist/library/setup/index.d.ts",
      "./library/setup (default): expected ./dist/library/setup.js, got ./dist/library/internal/writer.js",
    ]);
  });

  test("invalid export target shapes fail rather than disappear", () => {
    const root = fixture([source]);
    expect(() =>
      checkCoreExports(root, { exports: { "./library/setup": null } }, declarations),
    ).toThrow("Unsupported exports target");
  });

  test("declarations require their exact source file", () => {
    const root = fixture([]);
    expect(checkCoreExports(root, { exports: { "./library/setup": entry } }, declarations)).toEqual(
      [`./library/setup: missing source ${source}`],
    );
  });
});
