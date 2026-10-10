import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { skitLayer } from "@smolai/skit-core";
import { pnpmSkillOwner, leavePnpmSkillEffect } from "../src/projection/pnpm-skills.js";
import { fileProvenance } from "../src/audit/provenance.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { SetupResult } from "../src/workflows/library/setup-contract.js";
import { setupDiscoveredSkillChoices } from "../src/presentation/setup-skills.js";
import { setupRemovablePaths, applySetupRemovals } from "../src/workflows/library/setup-removal.js";
import { applySetupLocalCustody } from "../src/workflows/library/setup-local-custody.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

const fixture = Effect.fn("Test.pnpmFixture")(function* (yaml = false) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-pnpm-"));
  const modules = join(root, "node_modules");
  const pkg = join(modules, ".pnpm", "demo@1.0.0", "node_modules", "@acme", "demo");
  const skill = join(pkg, "skills", "guide");
  const alias = join(root, ".agents", "skills", "pnpm-@acme+demo-guide");
  yield* fs.makeDirectory(skill, { recursive: true });
  yield* fs.makeDirectory(dirname(alias), { recursive: true });
  yield* fs.writeFileString(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/demo", version: "1.0.0" }),
  );
  yield* fs.writeFileString(
    join(skill, "SKILL.md"),
    "---\nname: demo-guide\ndescription: Test pnpm distribution\n---\n\nFixture\n",
  );
  yield* fs.symlink(skill, alias);
  const ledgerPath = join(modules, ".modules.yaml");
  const entry = ".agents/skills/pnpm-@acme+demo-guide";
  yield* fs.writeFileString(
    ledgerPath,
    yaml
      ? `packageManager: pnpm@12.11.0\nlinkedSkills:\n  - ${entry}\n`
      : JSON.stringify({ packageManager: "pnpm@12.11.0", linkedSkills: [entry] }),
  );
  return { fs, root, pkg, skill, alias, ledgerPath };
});

for (const yaml of [false, true]) {
  it.effect(`attributes live pnpm links using ${yaml ? "YAML" : "JSON"} ledger evidence`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(yaml);
      const expected = {
        kind: "pnpm",
        package: "@acme/demo",
        version: "1.0.0",
        ledgerPath: f.ledgerPath,
      };
      expect(yield* pnpmSkillOwner(f.alias)).toEqual(expected);
      expect(yield* pnpmSkillOwner(f.skill)).toEqual(expected);
      expect(yield* fileProvenance(join(f.alias, "SKILL.md"), {}, "demo-guide")).toEqual({
        confidence: "exact",
        source: "pnpm · @acme/demo@1.0.0",
        evidence: f.ledgerPath,
      });
      expect((yield* Effect.result(leavePnpmSkillEffect(f.alias)))._tag).toBe("Failure");
    }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("does not infer pnpm management from a prefix, stale ledger, or replaced directory", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.writeFileString(f.ledgerPath, "{}");
    expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
    yield* f.fs.writeFileString(
      f.ledgerPath,
      JSON.stringify({
        packageManager: "pnpm@12.11.0",
        linkedSkills: ["../.agents/skills/pnpm-@acme+demo-guide"],
      }),
    );
    expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
    yield* f.fs.writeFileString(
      f.ledgerPath,
      JSON.stringify({
        packageManager: "pnpm@12.11.0",
        linkedSkills: [".agents/skills/pnpm-@acme+demo-guide"],
      }),
    );
    yield* f.fs.remove(f.alias, { recursive: true });
    yield* f.fs.makeDirectory(f.alias);
    expect(yield* pnpmSkillOwner(f.skill)).toBeUndefined();
    yield* f.fs.remove(f.alias, { recursive: true });
    yield* f.fs.symlink(join(f.root, "missing"), f.alias);
    expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
    yield* f.fs.writeFileString(f.ledgerPath, "[malformed");
    expect(yield* pnpmSkillOwner(f.skill)).toBeUndefined();
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "recognizes linked workspace packages only when the installed dependency corroborates the target",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const local = join(f.root, "packages", "demo");
      yield* f.fs.makeDirectory(dirname(local), { recursive: true });
      yield* f.fs.rename(f.pkg, local);
      yield* f.fs.remove(f.alias);
      const skill = join(local, "skills", "guide");
      yield* f.fs.symlink(skill, f.alias);
      expect(yield* pnpmSkillOwner(f.alias)).toBeUndefined();
      yield* f.fs.makeDirectory(join(f.root, "node_modules", "@acme"), { recursive: true });
      yield* f.fs.symlink(local, join(f.root, "node_modules", "@acme", "demo"));
      expect((yield* pnpmSkillOwner(f.alias))?.kind).toBe("pnpm");
      expect((yield* pnpmSkillOwner(skill))?.kind).toBe("pnpm");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("reports pnpm copies but excludes acquisition, setup selection and removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(
      yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
        ChildProcess.make("git", ["init", "-q"], { cwd: f.root }),
      ),
    ).toBe(0);
    const home = yield* libraryHome({
      home: join(f.root, "library"),
      inventoryHome: join(f.root, "home"),
    });
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      repositoryRoots: [f.root],
      persistRoots: false,
      probePath: "",
    };
    const observed = yield* home.owned(runSetup(options));
    expect(Schema.is(SetupResult)(observed)).toBe(true);
    const instance = observed.instances.find((item) => item.name === "demo-guide");
    expect(instance?.owner.kind).toBe("pnpm");
    expect(instance?.aliases).toContain(f.alias);
    expect(observed.onboarding.candidates.some((item) => item.name === "demo-guide")).toBe(false);
    const row = setupDiscoveredSkillChoices(
      observed.instances,
      observed.onboarding.candidates,
    ).find((item) => item.instance.name === "demo-guide");
    expect(row?.choice.disabled).toBe(true);
    expect(row?.details).toContain("Managed by pnpm · left in place");
    expect((yield* setupRemovablePaths(options, observed)).has(f.skill)).toBe(false);
    const add = yield* Effect.result(home.owned(addLibrarySourceEffect(f.alias)));
    expect(add._tag).toBe("Failure");
    if (add._tag === "Failure") expect(add.failure._tag).toBe("PnpmSkillManaged");
    const takeover = yield* Effect.result(
      home.owned(
        applySetupLocalCustody(
          { setup: options, adoption: { acquisition: home.addOptions, bindings: home.bindings } },
          observed.onboarding.planId,
          [{ name: "demo-guide", sourcePath: f.skill }],
        ),
      ),
    );
    expect(takeover._tag).toBe("Failure");
    const removal = yield* Effect.result(
      applySetupRemovals({
        recoveryDirectory: join(f.root, "removed"),
        entries: [
          {
            name: "demo-guide",
            path: f.alias,
            recoveryPath: join(f.root, "removed", "alias"),
            type: "SymbolicLink",
            dev: 0,
            ino: 0,
          },
        ],
      }),
    );
    expect(removal._tag).toBe("Failure");
    if (removal._tag === "Failure") expect(removal.failure._tag).toBe("PnpmSkillManaged");
    expect(yield* f.fs.readLink(f.alias)).toBe(f.skill);
    expect((yield* home.durable).skills).toHaveLength(0);
    expect(yield* f.fs.exists(join(f.root, "removed"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);
