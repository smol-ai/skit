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
  production = false,
): Promise<number[]> {
  const file = join(root, path.replace("PROBE", `layout-probe-${process.pid}-${Date.now()}`));
  const directory = await mkdtemp(join(tmpdir(), "skit-directory-layout-"));
  const config = production ? join(root, ".oxlintrc.json") : join(directory, ".oxlintrc.json");
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
  if (!production)
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
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    // A plugin/parser failure must never look like an allowed import.
    expect(report.diagnostics.filter((item) => !item.code)).toEqual([]);
    expect(result.status).toBe(report.diagnostics.some((item) => item.code.includes(rule)) ? 1 : 0);
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
  test("production config rejects reverse dependencies and accepts public owner APIs", async () => {
    expect(
      await reported(
        "packages/skit/src/library/PROBE.ts",
        'export { presentSetEnabled } from "../../../cli/src/library/enable.js";',
        "import-direction",
        undefined,
        true,
      ),
    ).toEqual([1]);
    expect(
      await reported(
        "packages/cli/src/library/PROBE.ts",
        'export type { SetEnabledPlan } from "@smolai/skit-core/library/enable";',
        "import-direction",
        undefined,
        true,
      ),
    ).toEqual([]);
  });
  test.each([
    'import { presentSetEnabled } from "../../../cli/src/library/enable.js";',
    'import type { SetEnabledCommandInput } from "../../../cli/src/library/enable.js";',
    'export * from "../../../cli/src/library/enable.js";',
    'const cli = import("../../../cli/src/library/enable.js");',
    'type Input = import("../../../cli/src/library/enable.js").SetEnabledCommandInput;',
    'import "@smolai/skit";',
    'export * from "@smolai/skit/storybook";',
    'const tui = import("../../../tui/src/index.ts");',
    'import "../../../storybook/src/main.ts";',
    'import "../../../skit-server-effect/src/application.ts";',
    'import "../../../devtools/src/main.ts";',
  ])("core cannot depend on application code: %s", async (source) => {
    expect(
      await reported("packages/skit/src/library/PROBE.ts", source, "import-direction"),
    ).toEqual([1]);
  });

  test.each([
    'import { value } from "@smolai/skit-core/library/internal/session/queries";',
    'export * from "@smolai/skit-core/library/session.js";',
    'const value = import("@smolai/skit-core/not-a-public-entry");',
    'type Value = import("@smolai/skit-core/library/internal/session/queries").Value;',
    'import { LibraryState } from "../../../skit/src/library/index.js";',
    'export * from "../../../skit/dist/library/index.js";',
    'const library = import("../../../skit/src/library/index.js");',
    'type Library = import("../../../skit/src/library/index.js").Interface;',
  ])("consumers must use declared core package entries: %s", async (source) => {
    expect(await reported("packages/cli/src/library/PROBE.ts", source, "import-direction")).toEqual(
      [1],
    );
  });

  test.each([
    [
      "packages/cli/src/library/PROBE.ts",
      'import type { Interface } from "@smolai/skit-core/library";',
    ],
    [
      "packages/cli/src/library/PROBE.ts",
      'type Library = import("@smolai/skit-core/library").Interface;',
    ],
    ["packages/skit/src/library/PROBE.ts", 'import { LibraryState } from "./library-state.js";'],
    [
      "packages/skit/test/PROBE.ts",
      'import { LibraryState } from "../src/library/library-state.js";',
    ],
    ["packages/skit/src/library/PROBE.ts", 'import type { Context } from "effect";'],
  ])("legitimate owner and public imports pass: %s", async (path, source) => {
    expect(await reported(path, source, "import-direction")).toEqual([]);
  });

  test("installed-skill byte adapters cannot import Library policy through direct paths or public aliases", async () => {
    for (const source of [
      'import type { LibraryState } from "../library/library-state.js";',
      'import { globalEnabled as enabled } from "../library/enabled.js";',
      'import * as versions from "../library/installation/retained-skill.js";',
      'export * from "../library/installation/retained-skill.js";',
      'const versions = import("../library/installation/retained-skill.js");',
      'import * as Library from "@smolai/skit-core/library";',
      'import * as settings from "@smolai/skit-core/machine-settings";',
      'const source = import("@smolai/skit-core/library/source");',
    ])
      expect(
        await reported("packages/skit/src/installed-skills/PROBE.ts", source, "import-direction"),
      ).toEqual([1]);
    for (const source of [
      'import type { InstalledSkill } from "../library/device-state.js";',
      'import { makeOperationId } from "../library/entity-ids.js";',
    ])
      expect(
        await reported("packages/skit/src/installed-skills/PROBE.ts", source, "import-direction"),
      ).toEqual([]);
  });

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

  test.each([
    "packages/cli/src/main.ts",
    "packages/tui/src/index.ts",
    "packages/skit-server-effect/src/application.ts",
    "packages/cli/test/consumer.test.ts",
    "packages/skit/test/consumer.test.ts",
  ])("the removed root is forbidden for every consumer: %s", async (filename) => {
    for (const source of [
      'import { LibraryState } from "@smolai/skit-core";',
      'import type { LibraryState } from "@smolai/skit-core";',
      'export { LibraryState } from "@smolai/skit-core";',
      'const core = import("@smolai/skit-core");',
    ])
      expect(
        await reported("packages/skit/test/PROBE.ts", source, "import-direction", filename),
      ).toEqual([1]);
    expect(
      await reported(
        "packages/skit/test/PROBE.ts",
        'import type { Hash } from "@smolai/skit-core/shared";',
        "import-direction",
        filename,
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
