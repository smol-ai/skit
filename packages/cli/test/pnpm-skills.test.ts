import { saveRecoveryFiles } from "./helpers/recovery-files.js";
import { dirname, join } from "node:path";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { skitLayer, skitConfigurationLayer } from "@smolai/skit-core/platform";

import { auditLocalCapabilitiesV1Alpha4 } from "@smolai/skit-core/audit";
import { runSetup, SetupResult, setupRemovablePaths } from "@smolai/skit-core/library/setup";

import { setupDiscoveredSkillChoices } from "../src/library/setup/skills.js";

import { applySetupSelections } from "./helpers/setup-apply.js";
import { importSource, inspectLibrarySource } from "../src/library/source.js";
import { libraryHome, scratch, writingTo } from "./helpers/library-home.js";

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

it.effect("refuses parent-directory acquisition before retaining any pnpm member", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const home = yield* libraryHome({ home: join(f.root, "library") });
    for (const declared of [false, true]) {
      if (declared)
        yield* f.fs.writeFileString(
          join(f.pkg, "skit.json"),
          JSON.stringify({ slug: "demo", skills: [{ name: "demo-guide", path: "skills/guide" }] }),
        );
      for (const input of [f.pkg, join(f.pkg, "skills")]) {
        const results = yield* Effect.all([
          Effect.result(home.owned(inspectLibrarySource(input))),
          Effect.result(home.owned(writingTo(home.home, importSource(input)))),
        ]);
        for (const result of results) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("PnpmSkillManaged");
        }
      }
      expect((yield* home.snapshot)._tag).toBe("Absent");
    }
    expect(yield* f.fs.readLink(f.alias)).toBe(f.skill);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("keeps an authored workspace source distinct from pnpm's recorded aliases", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const local = join(f.root, "packages", "demo");
    yield* f.fs.makeDirectory(dirname(local), { recursive: true });
    yield* f.fs.rename(f.pkg, local);
    yield* f.fs.remove(f.alias);
    const skill = join(local, "skills", "guide");
    yield* f.fs.symlink(skill, f.alias);
    yield* f.fs.makeDirectory(join(f.root, "node_modules", "@acme"), { recursive: true });
    yield* f.fs.symlink(local, join(f.root, "node_modules", "@acme", "demo"));
    yield* f.fs.writeFileString(
      join(local, "skit.json"),
      JSON.stringify({ slug: "demo", skills: [{ name: "demo-guide", path: "skills/guide" }] }),
    );
    yield* f.fs.writeFileString(
      join(local, "skit.remote.json"),
      JSON.stringify({
        schema: "skit.remote.v1",
        origin: "https://registry.test",
        namespace: "tim",
        skit: "demo",
      }),
    );
    const process = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const cwd of [f.root, local])
      expect(yield* process.exitCode(ChildProcess.make("git", ["init", "-q"], { cwd }))).toBe(0);
    expect(
      yield* process.exitCode(
        ChildProcess.make("git", ["add", "skills/guide/SKILL.md"], { cwd: local }),
      ),
    ).toBe(0);
    const home = yield* libraryHome({
      home: join(f.root, "library"),
      inventoryHome: join(f.root, "home"),
    });
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      repositoryRoots: [f.root, local],
      persistRoots: false,
      probePath: "",
    };
    const scan = yield* home.owned(runSetup(options));
    const source = scan.instances.find((item) => item.path === skill);
    const installed = scan.instances.find((item) => item.path === f.alias);
    expect(source?.owner.kind).toBe("authored");
    expect(source?.aliases).not.toContain(f.alias);
    expect(installed?.owner.kind).toBe("pnpm");
    expect(scan.onboarding.candidates.some((item) => item.paths.includes(f.alias))).toBe(false);
    expect((yield* setupRemovablePaths(options, scan)).has(f.alias)).toBe(false);
    const imported = yield* home.owned(writingTo(home.home, importSource(skill)));
    expect(imported.skills.map((item) => item.name)).toEqual(["demo-guide"]);
    expect(yield* f.fs.readLink(f.alias)).toBe(skill);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("does not attribute an unrecorded user alias to pnpm", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const alias = join(f.root, ".agents", "skills", "user-guide");
    yield* f.fs.symlink(f.skill, alias);
    // Audit deduplicates aliases of one physical Skill. Inspect the user alias on its own.
    yield* f.fs.remove(f.alias);
    const audited = yield* auditLocalCapabilitiesV1Alpha4({ home: f.root, cwd: f.root }).pipe(
      Effect.provide(skitConfigurationLayer()),
    );
    expect(
      audited.skills.find((entry) => entry.location === join(alias, "SKILL.md"))?.provenance.source,
    ).toBe("symlink");
    yield* f.fs.symlink(f.skill, f.alias);
    const home = yield* libraryHome({
      home: join(f.root, "library"),
      inventoryHome: join(f.root, "home"),
      roots: { codex: [dirname(alias)] },
    });
    const options = {
      libraryHome: home.home,
      inventory: home.inventory,
      repositoryRoots: [],
      persistRoots: false,
      probePath: "",
    };
    const scan = yield* home.owned(runSetup(options));
    const instance = scan.instances.find((item) => item.path === alias);
    expect(instance?.owner.kind).toBe("unknown");
    expect(scan.onboarding.candidates.some((item) => item.paths.includes(alias))).toBe(false);
    const row = setupDiscoveredSkillChoices(scan.instances, scan.onboarding.candidates).find(
      (item) => item.instance.path === alias,
    );
    expect(row?.choice.disabled).toBe(true);
    expect(row?.details).toContain("Left in place · no setup action");
    expect((yield* setupRemovablePaths(options, scan)).get(alias)).toEqual([alias]);
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
    const scan = yield* home.owned(runSetup(options));
    expect(Schema.is(SetupResult)(scan)).toBe(true);
    const instance = scan.instances.find((item) => item.name === "demo-guide");
    expect(instance?.owner.kind).toBe("pnpm");
    expect(instance?.aliases).toContain(f.alias);
    expect(scan.onboarding.candidates.some((item) => item.name === "demo-guide")).toBe(false);
    const row = setupDiscoveredSkillChoices(scan.instances, scan.onboarding.candidates).find(
      (item) => item.instance.name === "demo-guide",
    );
    expect(row?.choice.disabled).toBe(true);
    expect(row?.details).toContain("Managed by pnpm · left in place");
    expect((yield* setupRemovablePaths(options, scan)).has(f.skill)).toBe(false);
    const add = yield* Effect.result(home.owned(importSource(f.alias)));
    expect(add._tag).toBe("Failure");
    if (add._tag === "Failure") expect(add.failure._tag).toBe("PnpmSkillManaged");
    const takeover = yield* Effect.result(
      home.owned(
        applySetupSelections(options, scan, home.installOptions, {
          ownership: [{ name: "demo-guide", sourcePath: f.skill }],
        }),
      ),
    );
    expect(takeover._tag).toBe("Failure");
    const removal = (yield* saveRecoveryFiles(home.home, [f.alias])).result;
    expect(removal._tag).toBe("Stopped");
    if (removal._tag === "Stopped" && removal.reason._tag === "StepFailed")
      expect(Schema.is(Schema.TaggedStruct("PnpmSkillManaged", {}))(removal.reason.error)).toBe(
        true,
      );
    expect(yield* f.fs.readLink(f.alias)).toBe(f.skill);
    expect((yield* home.durable).skills).toHaveLength(0);
    expect(yield* f.fs.exists(join(f.root, "removed"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);
