import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const pluginPath = join(import.meta.dirname, "oxlint-plugin-skit.mjs");
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

/** Lints one file outside every owner and returns the first word of each report from `rule`. */
async function reported(
  source: string | ((directory: string) => string),
  rule = "owner-boundaries",
  filename?: string,
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "skit-owner-boundaries-"));
  const file = join(directory, "handler.ts");
  await writeFile(file, typeof source === "string" ? source : source(directory));
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
    join(directory, ".oxlintrc.json"),
    JSON.stringify({ jsPlugins: [configuredPlugin], rules: { [`skit/${rule}`]: "error" } }),
  );
  const result = spawnSync(
    process.execPath,
    [oxlintPath, "--config", join(directory, ".oxlintrc.json"), "--format=json", file],
    { encoding: "utf8", cwd: root },
  );
  const report = JSON.parse(result.stdout) as {
    diagnostics: Array<{ code: string; message: string }>;
  };
  return report.diagnostics
    .filter((item) => item.code.includes(rule))
    .map((item) => item.message.split(" ")[0] ?? "");
}

describe("skit/owner-boundaries", () => {
  test("Library's private modules reject renamed helpers, namespace and side-effect imports", async () => {
    const module = (directory: string) =>
      relative(directory, join(root, "packages/skit/src/library/store/state-file.js"));
    for (const statement of [
      (source: string) => `import { arbitraryHelper as renamed } from "${source}";`,
      (source: string) => `import * as storage from "${source}";`,
      (source: string) => `import "${source}";`,
      (source: string) => `export * from "${source}";`,
      (source: string) => `const loading = import("${source}");`,
    ]) {
      expect(await reported((directory) => statement(module(directory)))).toHaveLength(1);
    }
  });

  test("private unit tests use the real module; public barrels never grant test authority", async () => {
    expect(
      await reported(
        `import { prepareRecoveryMoves } from "../src/library/internal/recovery/moves.js";`,
        "owner-boundaries",
        "packages/skit/test/recovery-moves.test.ts",
      ),
    ).toEqual([]);
    expect(
      await reported(
        `import { writeCollectionVersion } from "../src/library/internal/content/collection-version.js";`,
        "owner-boundaries",
        "packages/skit/test/local-retention.test.ts",
      ),
    ).toEqual([]);
    expect(
      await reported(
        `import { writeCollectionVersion } from "../src/library/collection-version.js";`,
        "owner-boundaries",
        "packages/skit/test/local-retention.test.ts",
      ),
    ).toEqual(["writeCollectionVersion"]);
    expect(
      await reported(
        `import { prepareRecoveryMoves } from "@smolai/skit-core";`,
        "owner-boundaries",
        "packages/skit/test/recovery-moves.test.ts",
      ),
    ).toEqual(["prepareRecoveryMoves"]);
  });

  test("old ownership-marker readers stay private to installed-skill inspection", async () => {
    expect(
      await reported(
        `export { StoredOwnershipMarker } from "./installed-skills/ownership-marker-compat.js";`,
        "owner-boundaries",
        "packages/skit/src/index.ts",
      ),
    ).toHaveLength(1);
    expect(await reported(`import { StoredOwnershipMarker } from "@smolai/skit-core";`)).toEqual([
      "StoredOwnershipMarker",
    ]);
    expect(
      await reported(
        `import { StoredOwnershipMarker } from "./ownership-marker-compat.js";`,
        "owner-boundaries",
        "packages/skit/src/installed-skills/files.ts",
      ),
    ).toEqual([]);
  });

  test("Registry credential readers and OS-store access stay behind the owner", async () => {
    expect(
      await reported(
        `import { resolveAuthForOrigin } from "../../registry/auth.js";`,
        "owner-boundaries",
        "packages/cli/src/library/commands/example.ts",
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        `import { readStoredToken } from "../../registry/credential-store.js";`,
        "owner-boundaries",
        "packages/cli/src/library/commands/example.ts",
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        `import { Registry } from "../../registry/index.js";`,
        "owner-boundaries",
        "packages/cli/src/library/commands/example.ts",
      ),
    ).toEqual([]);
  });

  test("a handler cannot take the Library's home lock", async () => {
    expect(await reported(`import { withHomeLock } from "@smolai/skit-core";`)).toEqual([
      "withHomeLock",
    ]);
  });

  test("new recovery callers must use Library instead of opening a move or restore writer", async () => {
    expect(
      await reported(
        `import { prepareRecoveryMoves, prepareRecoveryRestore } from "@smolai/skit-core";`,
      ),
    ).toEqual(["prepareRecoveryMoves", "prepareRecoveryRestore"]);
  });

  test("re-exporting a private name is the same bypass", async () => {
    expect(await reported(`export { withHomeLock } from "@smolai/skit-core";`)).toEqual([
      "withHomeLock",
    ]);
  });

  test("calling the owner is allowed", async () => {
    expect(await reported(`import { Library, InstalledSkills } from "@smolai/skit-core";`)).toEqual(
      [],
    );
  });

  test("Author target authority stays inside its owner and package-local unit tests", async () => {
    const source = `import * as checks from "../src/author/local-tree.js";`;
    expect(
      await reported(source, "owner-boundaries", "packages/skit/test/author-local-tree.test.ts"),
    ).toEqual([]);
    expect(
      await reported(
        `import * as checks from "../../skit/src/author/local-tree.js";`,
        "owner-boundaries",
        "packages/cli/src/example.ts",
      ),
    ).toHaveLength(1);
  });

  test("a handler cannot write author state around AuthorWorkspace or AuthorHistory", async () => {
    const module = (directory: string, path: string) =>
      relative(directory, join(root, "packages/skit/src", `${path}.js`));
    expect(
      await reported(
        (directory) =>
          `import { writeWorkspaceTree } from "${module(directory, "author/write-tree")}";
import { makeHistoryStore } from "${module(directory, "author/history-store")}";`,
      ),
    ).toEqual(["writeWorkspaceTree", "makeHistoryStore"]);
  });

  test.each(["packages/skit/test/recovery-moves.test.ts", "packages/skit/src/index.ts"])(
    "previously exempt paths cannot import or export private names: %s",
    async (filename) => {
      expect(
        await reported(
          `export { prepareRecoveryMoves } from "@smolai/skit-core";`,
          "owner-boundaries",
          filename,
        ),
      ).toEqual(["prepareRecoveryMoves"]);
    },
  );
});

describe("skit/approved-services", () => {
  test("a new coordinator service is rejected", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
class AuthorSync extends Context.Service<AuthorSync, {}>()("skit/AuthorSync") {}`,
        "approved-services",
      ),
    ).toEqual(["skit/AuthorSync"]);
  });

  test("a new context reference is rejected", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
export const Flag = Context.Reference<boolean>("skit/Flag", { defaultValue: () => false });`,
        "approved-services",
      ),
    ).toEqual(["skit/Flag"]);
  });

  test("an approved owner is allowed", async () => {
    expect(
      await reported(
        `import { Context } from "effect";
class Library extends Context.Service<Library, {}>()("skit/library/Library") {}`,
        "approved-services",
      ),
    ).toEqual([]);
  });

  test.each([
    "skit/artifact/TreeHasher",
    "skit/library/LibraryActor",
    "@skit-server-effect/LibrarySync",
  ])("a previously exempt service is rejected: %s", async (id) => {
    expect(
      await reported(
        `import { Context } from "effect"; class Legacy extends Context.Service<Legacy, {}>()(${JSON.stringify(id)}) {}`,
        "approved-services",
      ),
    ).toEqual([id]);
  });
});
