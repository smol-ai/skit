import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  enabledSkillIds,
  currentSkillVersion,
  MachineSettings,
  skitLayer,
  type LibraryState,
  type Hash,
} from "@smolai/skit-core";
import {
  reverseSetupDiscovery,
  reverseSetupIntent,
  setupDiscoverySettings,
  setupIntent,
} from "../src/library-application/setup-undo-intent.js";
import {
  deterministicTreeHash,
  libraryHome,
  importCollectionIn,
  scratch,
  writingTo,
} from "./helpers/library-home.js";

const fixture = Effect.fn("Test.undoIntentFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-undo-intent-"));
  const home = yield* libraryHome({ home: join(root, "library") });
  for (const name of ["existing", "chosen", "later"]) {
    const source = join(root, name);
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(
      join(source, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n\nVersion 1\n`,
    );
    yield* writingTo(
      home.home,
      importCollectionIn(home.home)({
        source: { type: "local", path: source },
        input: source,
        importedAt: "2026-10-01T00:00:00.000Z",
        skills: [
          {
            name,
            sourcePath: source,
            relativePath: ".",
            currentHash: yield* deterministicTreeHash(source),
          },
        ],
        lockFileEntries: [],
      }),
    );
  }
  const state = yield* home.durable;
  const skill = (name: string) => {
    const selected = state.skills.find((skill) => skill.name === name);
    if (!selected) throw new Error(`Missing retained ${name}`);
    return selected;
  };
  return {
    fs,
    root,
    home,
    state,
    existing: skill("existing"),
    chosen: skill("chosen"),
    later: skill("later"),
  };
});

it.effect(
  "an import changing a followed Collection's members cannot be mistaken for a complete intent inverse",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* scratch("skit-undo-membership-"));
      const home = yield* libraryHome({ home: join(root, "library") });
      const skills: {
        name: string;
        sourcePath: string;
        relativePath: string;
        currentHash: Hash;
      }[] = [];
      for (const name of ["existing", "introduced"]) {
        const path = join(root, name);
        yield* fs.makeDirectory(path);
        yield* fs.writeFileString(
          join(path, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name}\n---\n\nBytes\n`,
        );
        skills.push({
          name,
          sourcePath: path,
          relativePath: name,
          currentHash: yield* deterministicTreeHash(path),
        });
      }
      const importSource = (selected: typeof skills, date: string) =>
        writingTo(
          home.home,
          importCollectionIn(home.home)({
            input: "https://github.com/test/membership",
            source: { type: "github", owner: "test", repository: "membership" },
            importedAt: date,
            skills: selected,
            lockFileEntries: [],
          }),
        );
      yield* importSource(skills.slice(0, 1), "2026-10-01T00:00:00.000Z");
      const imported = yield* home.durable;
      const enabled = [{ collection: imported.collections[0].collection_id }];
      const before = { ...imported, enabled };
      yield* importSource(skills, "2026-10-02T00:00:00.000Z");
      const after = { ...(yield* home.durable), enabled };
      expect(enabledSkillIds(before, enabled)).toHaveLength(1);
      expect(enabledSkillIds(after, enabled)).toHaveLength(2);
      const inverse = reverseSetupIntent(after, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toContain(
        `Collection source membership ${imported.collections[0].collection_id} requires restoration before undo`,
      );
      expect(inverse.state.skills).toEqual(after.skills);
      expect(inverse.state.collection_versions).toEqual(after.collection_versions);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "restores binding membership and policy per key, preserving pre-existing enablement and unrelated later choices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before: LibraryState = {
        ...f.state,
        enabled: [{ skill: f.existing.skill_id }],
        invocation_policies: { [f.existing.skill_id]: "explicit" },
      };
      const after: LibraryState = {
        ...before,
        enabled: [...before.enabled, { skill: f.chosen.skill_id }],
        invocation_policies: {
          [f.existing.skill_id]: "implicit",
          [f.chosen.skill_id]: "explicit",
        },
      };
      const current: LibraryState = {
        ...after,
        enabled: [...after.enabled, { skill: f.later.skill_id }],
        invocation_policies: {
          ...after.invocation_policies,
          [f.later.skill_id]: "host-policy",
        },
      };
      const inverse = reverseSetupIntent(current, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.enabled).toEqual([
        { skill: f.existing.skill_id },
        { skill: f.later.skill_id },
      ]);
      expect(inverse.state.invocation_policies).toEqual({
        [f.existing.skill_id]: "explicit",
        [f.later.skill_id]: "host-policy",
      });
      expect(inverse.state.imports).toEqual(current.imports);
      expect(inverse.state.collection_versions).toEqual(current.collection_versions);
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
      const edited = {
        ...current,
        invocation_policies: {
          ...current.invocation_policies,
          [f.existing.skill_id]: "host-policy" as const,
        },
      };
      const conflict = reverseSetupIntent(edited, setupIntent(before), setupIntent(after));
      expect(conflict.conflicts).toContain(`account binding invocation ${f.existing.skill_id}`);
      expect(conflict.state.invocation_policies?.[f.existing.skill_id]).toBe("host-policy");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "restores a previous effective source Version without deleting retained Versions, and refuses a newer selection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* f.home.durable;
      const source = join(f.root, "chosen");
      yield* f.fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: chosen\ndescription: chosen\n---\n\nVersion 2\n",
      );
      yield* writingTo(
        f.home.home,
        importCollectionIn(f.home.home)({
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-10-02T00:00:00.000Z",
          skills: [
            {
              name: "chosen",
              sourcePath: source,
              relativePath: ".",
              currentHash: yield* deterministicTreeHash(source),
            },
          ],
          lockFileEntries: [],
        }),
      );
      const after = yield* f.home.durable;
      const initialVersion = currentSkillVersion(before, f.chosen)?.skill_version_id;
      const inverse = reverseSetupIntent(after, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      const restored = inverse.state.skills.find((skill) => skill.skill_id === f.chosen.skill_id);
      if (!restored) return yield* Effect.die(new Error("Retained Skill disappeared"));
      expect(currentSkillVersion(inverse.state, restored)?.skill_version_id).toBe(initialVersion);
      expect(restored.versions).toHaveLength(2);
      expect(inverse.state.imports).toEqual(after.imports);
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
      yield* f.fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: chosen\ndescription: chosen\n---\n\nVersion 3\n",
      );
      yield* writingTo(
        f.home.home,
        importCollectionIn(f.home.home)({
          source: { type: "local", path: source },
          input: source,
          importedAt: "2026-10-03T00:00:00.000Z",
          skills: [
            {
              name: "chosen",
              sourcePath: source,
              relativePath: ".",
              currentHash: yield* deterministicTreeHash(source),
            },
          ],
          lockFileEntries: [],
        }),
      );
      const current = yield* f.home.durable;
      const conflict = reverseSetupIntent(current, setupIntent(before), setupIntent(after));
      expect(conflict.conflicts).toContain(`selected Version ${f.chosen.skill_id}`);
      expect(conflict.state.skills).toEqual(current.skills);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "independent device choices are undone without changing account or later device choices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before: LibraryState = {
        ...f.state,
        enabled: [{ skill: f.later.skill_id }],
        device_skill_selection: {
          mode: "choose",
          enabled: [{ skill: f.existing.skill_id }],
        },
      };
      const after: LibraryState = {
        ...before,
        device_skill_selection: {
          mode: "choose",
          enabled: [{ skill: f.existing.skill_id }, { skill: f.chosen.skill_id }],
        },
      };
      const inverse = reverseSetupIntent(after, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.enabled).toEqual(before.enabled);
      expect(inverse.state.device_skill_selection).toEqual(before.device_skill_selection);
      const changedMode = reverseSetupIntent(
        { ...after, device_skill_selection: { mode: "follow-account" } },
        setupIntent(before),
        setupIntent(after),
      );
      expect(changedMode.conflicts).toContain("device binding selection mode");
      expect(changedMode.state.device_skill_selection).toEqual({ mode: "follow-account" });
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "machine settings inverse preserves later repository choices and reports newer roots instead of overwriting them",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = yield* MachineSettings.read(f.home.home);
      const after = yield* MachineSettings.updateDiscovery(f.home.home, {
        discoveryRoots: ["/chosen"],
        repositories: [{ path: "/chosen/repo", status: "watched" }],
      });
      const later = yield* MachineSettings.updateDiscovery(f.home.home, {
        repositories: [{ path: "/later/repo", status: "watched" }],
      });
      const inverse = reverseSetupDiscovery(
        later,
        setupDiscoverySettings(before),
        setupDiscoverySettings(after),
      );
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.settings.discoveryRoots).toEqual([]);
      expect(inverse.settings.repositories).toEqual([{ path: "/later/repo", status: "watched" }]);
      expect(inverse.settings.repositoryDecisionsInitialized).toBe(true);
      expect(inverse.settings.machineId).toBe(after.machineId);
      expect(
        reverseSetupDiscovery(
          inverse.settings,
          setupDiscoverySettings(before),
          setupDiscoverySettings(after),
        ).changed,
      ).toBe(false);
      const newer = yield* MachineSettings.updateDiscovery(f.home.home, {
        discoveryRoots: ["/newer"],
        repositories: [{ path: "/chosen/repo", status: "ignored" }],
      });
      const conflict = reverseSetupDiscovery(
        newer,
        setupDiscoverySettings(before),
        setupDiscoverySettings(after),
      );
      expect(conflict.conflicts).toEqual(["discovery roots", "repository decision /chosen/repo"]);
      expect(conflict.settings.discoveryRoots).toEqual(["/newer"]);
      expect(conflict.settings.repositories).toContainEqual({
        path: "/chosen/repo",
        status: "ignored",
      });
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "undoing the only setup enable preserves later fields the current schema does not own",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = f.state;
      const after: LibraryState = {
        ...before,
        enabled: [{ skill: f.chosen.skill_id }],
      };
      const later = Object.assign({}, after, { futureSetting: "keep" });
      const inverse = reverseSetupIntent(later, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.enabled).toEqual([]);
      expect(inverse.state).toHaveProperty("futureSetting", "keep");
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);
