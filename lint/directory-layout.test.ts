import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/**
 * Writes a probe file at `path` in the real tree (the rules judge repository paths), lints it with
 * `rule` alone, removes it, and returns the line of each report.
 */
async function reported(
  path: string,
  source: string,
  rule: string,
  filename?: string,
): Promise<number[]> {
  const file = join(root, path.replace("PROBE", `layout-probe-${process.pid}-${Date.now()}`));
  const directory = await mkdtemp(join(tmpdir(), "skit-directory-layout-"));
  const config = join(directory, ".oxlintrc.json");
  const configuredPlugin = filename ? join(directory, "plugin.mjs") : pluginPath;
  if (filename)
    await writeFile(
      configuredPlugin,
      `
    import plugin from ${JSON.stringify(pluginPath)};
    const rule = plugin.rules[${JSON.stringify(rule)}];
    export default { meta: plugin.meta, rules: { ${JSON.stringify(rule)}: {
      ...rule, create(context) { return rule.create({
        filename: ${JSON.stringify(join(root, filename))}, report: context.report.bind(context),
      }); },
    } } };
  `,
    );
  await writeFile(
    config,
    JSON.stringify({ jsPlugins: [configuredPlugin], rules: { [`skit/${rule}`]: "error" } }),
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

describe("skit/directory-layout", () => {
  test("a new file in a legacy folder is flagged once, at the top", async () => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "\n\nexport const probe = 1;\n",
        "directory-layout",
        "packages/cli/src/workflows/library/PROBE.ts",
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

  test("an existing legacy filename has no layout exemption", async () => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "export const probe = 1;",
        "directory-layout",
        "packages/cli/src/workflows/library/library-sync.ts",
      ),
    ).toEqual([1]);
  });
});

describe("skit/import-direction", () => {
  test("core implementations cannot re-enter the aggregate root, including type imports", async () => {
    for (const source of [
      'import type { LibraryManifest } from "@smolai/skit-core";',
      'import * as Core from "@smolai/skit-core";',
      'import type { LibraryManifest } from "../../../index.js";',
      'export { Library } from "../../../index.js";',
      'const core = import("@smolai/skit-core");',
    ])
      expect(
        await reported(
          "packages/skit/src/library/internal/sync/PROBE.ts",
          source,
          "import-direction",
        ),
      ).toEqual([1]);
    expect(
      await reported(
        "packages/skit/src/library/internal/sync/PROBE.ts",
        'import type { LibraryManifest } from "../../library-contracts.js";',
        "import-direction",
      ),
    ).toEqual([]);
  });

  test("Storybook uses its declared CLI story API; the TUI stays on core", async () => {
    const source = `import { journeyStories } from "@smolai/skit/storybook"; export const stories = journeyStories;`;
    expect(await reported("packages/storybook/src/PROBE.ts", source, "import-direction")).toEqual(
      [],
    );
    expect(await reported("packages/tui/src/PROBE.ts", source, "import-direction")).toEqual([1]);
    expect(
      await reported(
        "packages/storybook/src/PROBE.ts",
        `import * as privateCli from "@smolai/skit/src/front-end";`,
        "import-direction",
      ),
    ).toEqual([1]);
  });

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

  test("package-local unit tests can exercise an owner's internal implementation", async () => {
    expect(
      await reported(
        "packages/skit/test/PROBE.ts",
        `import { inverse } from "../src/library/internal/undo";\nexport const probe = inverse;\n`,
        "import-direction",
      ),
    ).toEqual([]);
  });

  test("another package's tests cannot reach the owner's internal implementation", async () => {
    expect(
      await reported(
        "packages/cli/test/PROBE.ts",
        `import { inverse } from "../../skit/src/library/internal/undo";\nexport const probe = inverse;\n`,
        "import-direction",
      ),
    ).toEqual([1]);
  });

  test.each(["packages/tui/src/index.ts", "packages/storybook/src/browser.ts"])(
    "a previously exempt frontend import fails: %s",
    async (filename) => {
      expect(
        await reported(
          "packages/cli/src/library/PROBE.ts",
          `import { Library } from "../../cli/src/front-end"; export const probe = Library;`,
          "import-direction",
          filename,
        ),
      ).toEqual([1]);
    },
  );

  test("the core barrel cannot forward another owner's internal implementation", async () => {
    expect(
      await reported(
        "packages/skit/test/PROBE.ts",
        `export { privateFunction } from "./library/internal/private";`,
        "import-direction",
        "packages/skit/src/index.ts",
      ),
    ).toEqual([1]);
  });
});

describe("skit/feature-entry", () => {
  test("flat feature-prefixed siblings belong inside the feature", async () => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "export const probe = 1;",
        "feature-entry",
        "packages/skit/src/library/setup-intent.ts",
      ),
    ).toEqual([1]);
  });
  test.each([
    "packages/skit/src/library/setup/setup-review.ts",
    "packages/skit/src/library/setup/undo/setup-files.ts",
    "packages/cli/src/library/enable/enable-command.ts",
  ])("repeated feature prefixes fail: %s", async (filename) => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "export const probe = 1;",
        "feature-entry",
        filename,
      ),
    ).toEqual([1]);
  });

  test.each([
    "packages/skit/src/library/setup/review.ts",
    "packages/skit/src/library/setup/undo/files.ts",
    "packages/cli/src/library/enable/command.ts",
    "packages/skit/src/library/store/state-file.ts",
  ])("unprefixed implementations and non-feature groups pass: %s", async (filename) => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        "export const probe = 1;",
        "feature-entry",
        filename,
      ),
    ).toEqual([]);
  });

  test.each([
    'import { review } from "./setup/review.js";',
    'export { review } from "./setup/review.js";',
    'export * from "./setup/review.js";',
    'const review = import("./setup/review.js");',
    'import { review } from "@smolai/skit-core/library/setup/review";',
  ])("outside callers cannot bypass a feature entry: %s", async (source) => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        source,
        "feature-entry",
        "packages/skit/src/library/other.ts",
      ),
    ).toEqual([1]);
  });

  test("the feature, its facade and package-local tests may use private implementation", async () => {
    for (const [filename, source] of [
      ["packages/skit/src/library/setup.ts", 'export { review } from "./setup/review.js";'],
      ["packages/skit/src/library/setup/plan.ts", 'import { review } from "./review.js";'],
      [
        "packages/skit/test/setup.test.ts",
        'import { review } from "../src/library/setup/review.js";',
      ],
      ["packages/skit/src/library/other.ts", 'import { setup } from "./setup.js";'],
    ]) {
      expect(
        await reported("packages/cli/src/library/PROBE.ts", source, "feature-entry", filename),
      ).toEqual([]);
    }
  });

  test("another package's tests cannot bypass the feature facade", async () => {
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        'import { review } from "../../skit/src/library/setup/review.js";',
        "feature-entry",
        "packages/cli/test/setup.test.ts",
      ),
    ).toEqual([1]);
  });
});
