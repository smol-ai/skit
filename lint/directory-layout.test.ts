import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { importDebt, layout, layoutDebt, undecided } from "../architecture/layout.mjs";

const root = join(import.meta.dirname, "..");
const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/**
 * Writes a probe file at `path` in the real tree (the rules judge repository paths), lints it with
 * `rule` alone, removes it, and returns the line of each report.
 */
async function reported(path: string, source: string, rule: string): Promise<number[]> {
  const file = join(root, path.replace("PROBE", `layout-probe-${process.pid}-${Date.now()}`));
  const directory = await mkdtemp(join(tmpdir(), "skit-directory-layout-"));
  const config = join(directory, ".oxlintrc.json");
  await writeFile(
    config,
    JSON.stringify({ jsPlugins: [pluginPath], rules: { [`skit/${rule}`]: "error" } }),
  );
  await writeFile(file, source);
  try {
    const result = spawnSync(
      process.execPath,
      [oxlintPath, "--config", config, "--format=json", file],
      {
        encoding: "utf8",
        cwd: root,
      },
    );
    const report = JSON.parse(result.stdout) as {
      diagnostics: Array<{ code: string; labels: Array<{ span: { line: number } }> }>;
    };
    return report.diagnostics
      .filter((item) => item.code.includes(rule))
      .map((item) => item.labels[0]?.span.line ?? 0);
  } finally {
    await rm(file, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

const inTarget = (file: string) => {
  const source = Object.keys(layout).find((path) => file.startsWith(path));
  if (source === undefined) return false;
  const target = layout[source as keyof typeof layout];
  const [top = "", ...rest] = file.slice(source.length).split("/");
  return rest.length === 0 ? target.files.includes(top) : target.folders.includes(top);
};
const isUndecided = (file: string) =>
  undecided.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));

describe("skit/directory-layout", () => {
  test("a new file in a legacy folder is flagged once, at the top", async () => {
    expect(
      await reported(
        "packages/cli/src/workflows/library/PROBE.ts",
        "\n\nexport const probe = 1;\n",
        "directory-layout",
      ),
    ).toEqual([1]);
  });

  test("a file in a target folder passes", async () => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "export const probe = 1;\n",
        "directory-layout",
      ),
    ).toEqual([]);
  });

  test("debt only shrinks: every listed file exists and is still outside the target", async () => {
    const stale: string[] = [];
    for (const file of layoutDebt) {
      const exists = await stat(join(root, file)).then(
        () => true,
        () => false,
      );
      if (!exists) stale.push(`${file}: no longer exists`);
      else if (inTarget(file)) stale.push(`${file}: now in the target`);
      else if (isUndecided(file)) stale.push(`${file}: undecided, not debt`);
    }
    if (new Set(layoutDebt).size !== layoutDebt.length) stale.push("duplicate entries");
    expect(stale, "Remove these from layoutDebt in architecture/layout.mjs").toEqual([]);
  });
});

describe("skit/import-direction", () => {
  test("the TUI importing CLI source is flagged", async () => {
    expect(
      await reported(
        "packages/tui/src/PROBE.ts",
        `import { Library } from "../../cli/src/library-application/index";\nexport const probe = Library;\n`,
        "import-direction",
      ),
    ).toEqual([1]);
  });

  test("an internal import from another owner is flagged", async () => {
    expect(
      await reported(
        "packages/skit/src/sync/PROBE.ts",
        `import { store } from "../library/internal/store/store";\nexport const probe = store;\n`,
        "import-direction",
      ),
    ).toEqual([1]);
  });

  test("an owner may import its own internal code", async () => {
    expect(
      await reported(
        "packages/skit/src/library/PROBE.ts",
        `import { store } from "./internal/store/store";\nexport const probe = store;\n`,
        "import-direction",
      ),
    ).toEqual([]);
  });

  test("debt only shrinks: every listed import still exists", async () => {
    const stale: string[] = [];
    for (const [file, targets] of Object.entries(importDebt)) {
      const text = await readFile(join(root, file), "utf8").catch(() => "");
      const imported = [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)]
        .map((match) => match[1] ?? "")
        .filter((source) => source.startsWith("."))
        .map((source) =>
          relative(root, resolve(dirname(join(root, file)), source)).replace(/\.js$/, ""),
        );
      for (const target of targets)
        if (!imported.includes(target)) stale.push(`${file}: ${target}`);
    }
    expect(stale, "Remove these from importDebt in architecture/layout.mjs").toEqual([]);
  });
});
