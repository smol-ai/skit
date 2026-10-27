import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  bindingSkillIds,
  currentSkillVersion,
  MachineSettings,
  skitLayer,
  type LibraryState,
  type Digest,
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
  retainObservedIn,
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
      retainObservedIn(home.home)({
        source: { type: "local", path: source },
        input: source,
        retainedAt: "2026-10-01T00:00:00.000Z",
        skills: [
          {
            name,
            sourcePath: source,
            relativePath: ".",
            observedHash: yield* deterministicTreeHash(source),
          },
        ],
        observations: [],
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
        observedHash: Digest;
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
          observedHash: yield* deterministicTreeHash(path),
        });
      }
      const retain = (selected: typeof skills, date: string) =>
        writingTo(
          home.home,
          retainObservedIn(home.home)({
            input: "https://github.com/test/membership",
            source: { type: "github", owner: "test", repository: "membership" },
            retainedAt: date,
            skills: selected,
            observations: [],
          }),
        );
      yield* retain(skills.slice(0, 1), "2026-10-01T00:00:00.000Z");
      const retained = yield* home.durable;
      const binding = {
        scope: { kind: "global" as const },
        entries: [
          { kind: "collection" as const, collection_id: retained.collections[0].collection_id },
        ],
      };
      const before = { ...retained, global_bindings: [binding] };
      yield* retain(skills, "2026-10-02T00:00:00.000Z");
      const after = { ...(yield* home.durable), global_bindings: [binding] };
      expect(bindingSkillIds(before, binding)).toHaveLength(1);
      expect(bindingSkillIds(after, binding)).toHaveLength(2);
      const inverse = reverseSetupIntent(after, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toContain(
        `Collection source membership ${retained.collections[0].collection_id} requires restoration before undo`,
      );
      expect(inverse.state.skills).toEqual(after.skills);
      expect(inverse.state.retained_copies).toEqual(after.retained_copies);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "restores binding membership and policy per key, preserving pre-existing enablement and unrelated later choices",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before: LibraryState = {
        ...f.state,
        global_bindings: [
          {
            scope: { kind: "global" },
            entries: [{ kind: "skill", skill_id: f.existing.skill_id }],
            invocation_policies: { [f.existing.skill_id]: "explicit" },
          },
        ],
      };
      const after: LibraryState = {
        ...before,
        global_bindings: [
          {
            scope: { kind: "global" },
            entries: [
              ...before.global_bindings[0].entries,
              { kind: "skill", skill_id: f.chosen.skill_id },
            ],
            invocation_policies: {
              [f.existing.skill_id]: "implicit",
              [f.chosen.skill_id]: "explicit",
            },
          },
        ],
      };
      const current: LibraryState = {
        ...after,
        global_bindings: [
          {
            ...after.global_bindings[0],
            entries: [
              ...after.global_bindings[0].entries,
              { kind: "skill", skill_id: f.later.skill_id },
            ],
            invocation_policies: {
              ...after.global_bindings[0].invocation_policies,
              [f.later.skill_id]: "host-policy",
            },
          },
        ],
      };
      const inverse = reverseSetupIntent(current, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.global_bindings[0].entries).toEqual([
        { kind: "skill", skill_id: f.existing.skill_id },
        { kind: "skill", skill_id: f.later.skill_id },
      ]);
      expect(inverse.state.global_bindings[0].invocation_policies).toEqual({
        [f.existing.skill_id]: "explicit",
        [f.later.skill_id]: "host-policy",
      });
      expect(inverse.state.acquisitions).toEqual(current.acquisitions);
      expect(inverse.state.retained_copies).toEqual(current.retained_copies);
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
      const edited = {
        ...current,
        global_bindings: [
          {
            ...current.global_bindings[0],
            invocation_policies: {
              ...current.global_bindings[0].invocation_policies,
              [f.existing.skill_id]: "host-policy" as const,
            },
          },
        ],
      };
      const conflict = reverseSetupIntent(edited, setupIntent(before), setupIntent(after));
      expect(conflict.conflicts).toContain(`account binding invocation ${f.existing.skill_id}`);
      expect(conflict.state.global_bindings[0].invocation_policies?.[f.existing.skill_id]).toBe(
        "host-policy",
      );
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
        retainObservedIn(f.home.home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-02T00:00:00.000Z",
          skills: [
            {
              name: "chosen",
              sourcePath: source,
              relativePath: ".",
              observedHash: yield* deterministicTreeHash(source),
            },
          ],
          observations: [],
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
      expect(inverse.state.acquisitions).toEqual(after.acquisitions);
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
      yield* f.fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: chosen\ndescription: chosen\n---\n\nVersion 3\n",
      );
      yield* writingTo(
        f.home.home,
        retainObservedIn(f.home.home)({
          source: { type: "local", path: source },
          input: source,
          retainedAt: "2026-10-03T00:00:00.000Z",
          skills: [
            {
              name: "chosen",
              sourcePath: source,
              relativePath: ".",
              observedHash: yield* deterministicTreeHash(source),
            },
          ],
          observations: [],
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
        global_bindings: [
          { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: f.later.skill_id }] },
        ],
        device_skill_selection: {
          mode: "choose",
          binding: {
            scope: { kind: "global" },
            entries: [{ kind: "skill", skill_id: f.existing.skill_id }],
          },
        },
      };
      const after: LibraryState = {
        ...before,
        device_skill_selection: {
          mode: "choose",
          binding: {
            scope: { kind: "global" },
            entries: [
              { kind: "skill", skill_id: f.existing.skill_id },
              { kind: "skill", skill_id: f.chosen.skill_id },
            ],
          },
        },
      };
      const inverse = reverseSetupIntent(after, setupIntent(before), setupIntent(after));
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.global_bindings).toEqual(before.global_bindings);
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
  "undoing the only setup binding preserves later fields the current schema does not own",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const before = f.state;
      const after: LibraryState = {
        ...before,
        global_bindings: [
          { scope: { kind: "global" }, entries: [{ kind: "skill", skill_id: f.chosen.skill_id }] },
        ],
      };
      const laterBinding = Object.assign({}, after.global_bindings[0], { futureSetting: "keep" });
      const inverse = reverseSetupIntent(
        { ...after, global_bindings: [laterBinding] },
        setupIntent(before),
        setupIntent(after),
      );
      expect(inverse.conflicts).toEqual([]);
      expect(inverse.state.global_bindings).toEqual([
        { scope: { kind: "global" }, entries: [], futureSetting: "keep" },
      ]);
      expect(
        reverseSetupIntent(inverse.state, setupIntent(before), setupIntent(after)).changed,
      ).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
);
