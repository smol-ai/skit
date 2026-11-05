import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const rulesPath = join(import.meta.dirname, "library-rules.mjs");
const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));
const library = "packages/skit/src/library/";

/** Run the actual oxlint engine, with a virtual policy filename so no source file is overwritten. */
async function reported(rule: string, filename: string, source: string): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "skit-library-rules-"));
  try {
    const plugin = join(directory, "plugin.mjs");
    await writeFile(
      plugin,
      `
      import { libraryRules } from ${JSON.stringify(rulesPath)};
      const rule = libraryRules[${JSON.stringify(rule)}];
      export default {
        meta: { name: "skit" },
        rules: { ${JSON.stringify(rule)}: {
          ...rule,
          create(context) {
            return rule.create({
              filename: ${JSON.stringify(join(root, filename))},
              report: context.report.bind(context),
            });
          },
        } },
      };
    `,
    );
    const config = join(directory, ".oxlintrc.json");
    await writeFile(
      config,
      JSON.stringify({ jsPlugins: [plugin], rules: { [`skit/${rule}`]: "error" } }),
    );
    const fixture = join(directory, "fixture.ts");
    await writeFile(fixture, source);
    const result = spawnSync(
      process.execPath,
      [oxlintPath, "--config", config, "--format=json", fixture],
      {
        cwd: directory,
        encoding: "utf8",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBeNull();
    const output = JSON.parse(result.stdout) as {
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(
      output.diagnostics.filter(
        (item) => !item.code.startsWith("skit(") && item.code !== "eslint(no-unused-vars)",
      ),
    ).toEqual([]);
    const messages = output.diagnostics
      .filter((item) => item.code === `skit(${rule})`)
      .map((item) => item.message);
    expect(result.status).toBe(messages.length ? 1 : 0);
    return messages;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("skit/library-contract-complete", () => {
  test("whole-method and constructor exemptions fail even if TypeScript accepts the debt", async () => {
    const messages = await reported(
      "library-contract-complete",
      "architecture/conformance/library.ts",
      `
      type MissingDebt = never;
      type ExtraDebt = never;
      type ChangedDebt = "plan" | "apply";
      type RequirementDebt = InstalledSkills.Service;
    `,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("ChangedDebt");
    expect(messages[1]).toContain("RequirementDebt");
  });

  test("complete conformance is allowed", async () => {
    expect(
      await reported(
        "library-contract-complete",
        "architecture/conformance/library.ts",
        `
      type MissingDebt = never;
      type ExtraDebt = never;
      type ChangedDebt = never;
      type RequirementDebt = never;
    `,
      ),
    ).toEqual([]);
  });

  test("placeholder vocabulary fails; imported real vocabulary passes", async () => {
    expect(
      await reported(
        "library-contract-complete",
        "architecture/library-results.ts",
        `
      interface Ref<Where extends string> { readonly __ref: Where }
      type Hash = Ref<"Hash">;
    `,
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        "library-contract-complete",
        "architecture/library-results.ts",
        `
      import type { Hash } from "../packages/skit/src/vocabulary.js";
      export interface Change { readonly hash: Hash }
    `,
      ),
    ).toEqual([]);
  });
});

describe("skit/library-private-api", () => {
  test("the existing recovery-handler exemption no longer permits a callback writer", async () => {
    expect(
      await reported(
        "library-private-api",
        "packages/cli/src/handlers/library/recovery.ts",
        `
      import { prepareRecoveryRestore as restore } from "@smolai/skit-core";
      export const result = restore;
    `,
      ),
    ).toHaveLength(1);
  });

  test.each([
    `import { make as construct } from "@smolai/skit-core/library"; construct();`,
    `import * as core from "@smolai/skit-core"; core.withHomeLock();`,
    `import * as core from "@smolai/skit-core"; core["withHomeLock"]();`,
    `import * as core from "@smolai/skit-core"; const { withHomeLock: lock } = core;`,
    `import { Library as Owner } from "@smolai/skit-core/library"; Owner.make();`,
    `import * as Owner from "@smolai/skit-core/library"; Owner["make"]();`,
    `import { Library as Owner } from "@smolai/skit-core/library"; const { make: construct } = Owner;`,
    `import * as core from "@smolai/skit-core"; core.Library.make();`,
  ])("namespace/alias access cannot reopen a writer or raw constructor: %s", async (source) => {
    expect(
      await reported("library-private-api", "packages/cli/src/library/example.ts", source),
    ).toHaveLength(1);
  });

  test.each([
    `export * from "./library/import-collection.js";`,
    `export * as InstalledSkillFiles from "./install/files.js";`,
    `export * as InstalledSkillBackups from "./install/backups.js";`,
    `export * as imports from "./library/import-collection.js";`,
    `export { importCollection as write } from "./library/import-collection.js";`,
    `export { withHomeLock as lock } from "./library/store/writer-lock.js";`,
    `export { InstalledSkillV9 } from "./library/store/state-schema-v9.js";`,
  ])("the compatibility barrel cannot export private implementation: %s", async (source) => {
    expect(
      await reported("library-private-api", "packages/skit/src/index.ts", source),
    ).toHaveLength(1);
  });

  test("raw make stays private; the owner namespace and public operation vocabulary remain legal", async () => {
    expect(
      await reported(
        "library-private-api",
        `${library}library.ts`,
        `
      export { make as construct } from "./internal/runtime.js";
    `,
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        "library-private-api",
        `${library}library.ts`,
        `
      export * as Library from "./library.js";
      export { OperationStatus } from "./store/state-schema.js";
      export type { SetupStep } from "./store/state-schema.js";
      export { type LibraryStateReadError } from "./store/library-store.js";
    `,
      ),
    ).toEqual([]);
  });

  test("ordinary callers can use the public owner and read-only facts", async () => {
    expect(
      await reported(
        "library-private-api",
        "packages/cli/src/library/example.ts",
        `
      import { Library } from "@smolai/skit-core/library";
      import { inspectRecoveryOperation } from "@smolai/skit-core";
      export const use = [Library.layer, inspectRecoveryOperation];
    `,
      ),
    ).toEqual([]);
  });

  test.each([
    `import { InstalledSkills as Copies } from "@smolai/skit-core"; Copies.make();`,
    `import * as core from "@smolai/skit-core"; core.InstalledSkills.layer();`,
    `import { InstalledSkills } from "@smolai/skit-core"; const files = yield* InstalledSkills.Service; files.install();`,
    `import { InstalledSkills } from "@smolai/skit-core"; const files = yield* InstalledSkills.Service; files.backups.discard();`,
    `import { InstalledSkills } from "@smolai/skit-core"; const files = yield* InstalledSkills.Service; const { uninstall: remove } = files;`,
  ])(
    "frontends cannot construct InstalledSkills or take its mutation capabilities: %s",
    async (body) => {
      // Yield belongs to an actual generator, as it does in a handler.
      const split = body.indexOf(";") + 1;
      const source = `${body.slice(0, split)} function* handler() { yield 0; ${body.slice(split)} }`;
      expect(
        await reported("library-private-api", "packages/cli/src/library/example.ts", source),
      ).toHaveLength(1);
    },
  );

  test("InstalledSkills facts stay available outside Library; mutations stay usable inside it", async () => {
    const source = `
      import { InstalledSkills } from "@smolai/skit-core";
      function* inspect() {
        const files = yield* InstalledSkills.Service;
        yield* files.inspect("path");
        yield* files.backups.scan("root", "id");
      }
    `;
    expect(
      await reported("library-private-api", "packages/cli/src/library/example.ts", source),
    ).toEqual([]);
    expect(
      await reported(
        "library-private-api",
        `${library}apply-plan.ts`,
        `
      import { InstalledSkills } from "./installed-skills.js";
      function* execute() {
        const files = yield* InstalledSkills.Service;
        yield* files.install();
      }
    `,
      ),
    ).toEqual([]);
  });
});

describe("skit/library-recorded-execution", () => {
  test.each([
    `import { apply as run } from "../apply-plan.js";`,
    `import * as executor from "../apply-plan.js";`,
    `const executor = import("../apply-plan.js");`,
    `export { apply as run } from "../apply-plan.js";`,
    `export * from "../apply-plan.js";`,
  ])("the public runtime cannot call or relay the folder executor: %s", async (source) => {
    expect(
      await reported("library-recorded-execution", `${library}internal/runtime.ts`, source),
    ).toHaveLength(1);
  });

  test("recorded executors remain usable inside the journal execution graph", async () => {
    expect(
      await reported(
        "library-recorded-execution",
        `${library}internal/operations/operations.ts`,
        `
      import { apply as run } from "./apply.js";
      export const execute = run;
    `,
      ),
    ).toEqual([]);
    expect(
      await reported(
        "library-recorded-execution",
        `${library}setup.ts`,
        `
      import { runManage, runUpdate } from "./setup-manage.js";
      export const execute = [runManage, runUpdate];
    `,
      ),
    ).toEqual([]);
  });

  test("Undo must enter the recorded runner before executing its files", async () => {
    expect(
      await reported(
        "library-recorded-execution",
        `${library}internal/setup/undo.ts`,
        `
      import { prepareSetupUndoFiles } from "./undo-files.js";
    `,
      ),
    ).toHaveLength(1);
  });

  test("best-effort audit delivery is rejected at the writer; audit reads and types stay legal", async () => {
    expect(
      await reported(
        "library-recorded-execution",
        `${library}store/library-store.ts`,
        `
      import { appendLibraryAudit as append } from "../audit/audit-log.js";
    `,
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        "library-recorded-execution",
        `${library}store/library-store.ts`,
        `
      import { readLibraryAudit, type LibraryAuditEvent } from "../audit/audit-log.js";
      export type Event = LibraryAuditEvent;
      export const read = readLibraryAudit;
    `,
      ),
    ).toEqual([]);
  });

  test("a new helper cannot import or re-export a step executor around the runner", async () => {
    expect(
      await reported(
        "library-recorded-execution",
        `${library}new-helper.ts`,
        `
      import { runManage } from "./setup-manage.js";
      export { updateInstalledSkills } from "./installed-update.js";
    `,
      ),
    ).toHaveLength(2);
  });
});

describe("skit/library-operation-owner", () => {
  test.each([
    `import { LibraryWriter as writer } from "./store/library-store.js";`,
    `import * as store from "./store/library-store.js";`,
    `export { writeLibrary } from "./store/library-store.js";`,
    `const store = import("./store/library-store.js");`,
    `import { saveLibraryState } from "./store/state-file.js";`,
    `import { apply } from "./apply-plan.js";`,
  ])("adapters cannot reopen state or the old executor: %s", async (source) => {
    expect(
      await reported("library-operation-owner", `${library}setup-manage.ts`, source),
    ).toHaveLength(1);
  });
  test.each([
    `const files = yield* Copies.Service; files.install();`,
    `const files = yield* Copies.Service; files["uninstall"]();`,
    `const files = yield* Copies.Service; files.backups.discard();`,
    `const files = yield* Copies.Service; const { prepare: create } = files;`,
    `const files = yield* routed(); files.manage();`,
  ])("adapters cannot mutate installed files directly: %s", async (body) => {
    const source = `import { InstalledSkills as Copies } from "./installed-skills.js";
      import { routedInstalledSkills as routed } from "./routing/recorded.js";
      function* run() { ${body} }`;
    expect(
      await reported("library-operation-owner", `${library}setup-manage.ts`, source),
    ).toHaveLength(1);
  });
  test("adapters cannot import the replacement executor or journal writer directly", async () => {
    expect(
      await reported(
        "library-recorded-execution",
        `${library}setup-manage.ts`,
        `import { apply } from "./internal/operations/apply.js";`,
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        "library-recorded-execution",
        `${library}new-helper.ts`,
        `import { saveStep } from "./internal/operations/recorded.js";`,
      ),
    ).toHaveLength(1);
  });
  test("filesystem executor cannot obtain storage, but data types stay legal", async () => {
    expect(
      await reported(
        "library-operation-owner",
        `${library}internal/operations/installed-changes.ts`,
        `import { loadLibrary } from "../../store/library-store.js";`,
      ),
    ).toHaveLength(1);
    expect(
      await reported(
        "library-operation-owner",
        `${library}internal/operations/installed-changes.ts`,
        `import type { LibraryWriter } from "../../store/library-store.js";`,
      ),
    ).toEqual([]);
    expect(
      await reported(
        "library-operation-owner",
        `${library}setup-manage.ts`,
        `import { loadLibrary, type LibraryWriter } from "./store/library-store.js";`,
      ),
    ).toEqual([]);
  });
});

describe("skit/library-apply-program", () => {
  test.each([
    `import type { Plan } from "../../library-plan.js";`,
    `import { planIntent as again } from "../../plan-changes.js";`,
    `import * as planning from "../../plan-changes.js";`,
    `const planner = import("../../plan-changes.js");`,
    `import { reviewApply } from "./review.js";`,
  ])("execution cannot accept or reconstruct a Plan: %s", async (source) => {
    expect(
      await reported("library-apply-program", `${library}internal/operations/apply.ts`, source),
    ).toHaveLength(1);
  });
  test("execution may use errors and typed recorded work", async () => {
    expect(
      await reported(
        "library-apply-program",
        `${library}internal/operations/apply.ts`,
        `import { StalePlan } from "../../library-plan.js"; import type { InstalledApply } from "../../store/state-schema.js";`,
      ),
    ).toEqual([]);
  });
  test("legacy fields are forbidden in the live Apply codec", async () => {
    expect(
      await reported(
        "library-apply-program",
        `${library}store/state-schema.ts`,
        `const installedApply = Schema.TaggedStruct("Apply", { reviewed: Schema.Json, ids: Schema.Array(Schema.String), prepared: Schema.Boolean });`,
      ),
    ).toHaveLength(3);
  });
});
