import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { decodeLibraryState, type LibraryState } from "../src/library/library-state.js";
import { edit } from "../src/library/library-edit.js";
import type { SkillId } from "../src/library/entity-ids.js";
import type { InstallScope } from "../src/library/scope.js";
import type { Invocation } from "../src/library/device-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { SetupIntent, setupIntent } from "../src/library/store/intent.js";
import { prepareSetupChanges } from "../src/library/store/setup-intent.js";
import { reverseSetupIntent } from "../src/library/internal/setup/undo-intent.js";
import { inverseSetResult, reverseFullSetupIntent } from "./helpers/setup-intent-reference.js";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect("the 44-case First 1 matrix matches the full-intent inverse as sets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "skit-intent-matrix-" }),
    );
    const home = join(root, "library");
    const { state: rich } = yield* fixture;
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const paths = new Map<string, string>();
      for (const name of ["existing", "chosen", "later"]) {
        const path = join(root, name);
        paths.set(name, path);
        yield* fs.makeDirectory(path);
        yield* fs.writeFileString(
          join(path, "SKILL.md"),
          `---\nname: ${name}\ndescription: Matrix\n---\nOriginal\n`,
        );
        const request = yield* localImportRequest(path, "2026-10-01T00:00:00.000Z");
        if (Option.isNone(request)) return assert.fail("Missing matrix import");
        yield* library.import.collection(request.value);
      }
      const snapshot = yield* library.read;
      if (snapshot._tag !== "Present") return assert.fail("Missing matrix Library");
      const base = snapshot.state,
        first = base.skills.find((skill) => skill.name === "existing")!,
        chosen = base.skills.find((skill) => skill.name === "chosen")!;
      const change = (
        state: LibraryState,
        id: SkillId,
        scope: InstallScope,
        enabled: boolean,
        invocation?: Invocation,
      ) =>
        edit(state, {
          _tag: "Enabled",
          changes: [
            {
              _tag: enabled ? "Enable" : "Disable",
              subject: { _tag: "Skill", id },
              where: [scope],
              ...(invocation === undefined ? {} : { invocation }),
            },
          ],
        }).pipe(Effect.map((result) => result.next));
      const enabled = yield* change(base, chosen.skill_id, { kind: "global" }, true);
      const repository = join(root, "repository");
      yield* fs.makeDirectory(repository);
      const repo = yield* change(
        base,
        chosen.skill_id,
        { kind: "repository", root: repository },
        true,
      );
      const deviceBefore = yield* decodeLibraryState({
        ...base,
        device_skill_selection: { mode: "choose", enabled: [{ skill: first.skill_id }] },
      });
      const deviceAfter = yield* change(deviceBefore, chosen.skill_id, { kind: "global" }, true);
      const policyBefore = yield* change(
        base,
        chosen.skill_id,
        { kind: "global" },
        true,
        "explicit",
      );
      const policyAfter = yield* change(
        policyBefore,
        chosen.skill_id,
        { kind: "global" },
        true,
        "implicit",
      );
      yield* fs.writeFileString(
        join(paths.get("chosen")!, "SKILL.md"),
        "---\nname: chosen\ndescription: Matrix\n---\nUpdated\n",
      );
      const update = yield* localImportRequest(paths.get("chosen")!, "2026-10-02T00:00:00.000Z");
      if (Option.isNone(update)) return assert.fail("Missing updated source");
      yield* library.import.collection(update.value);
      const updated = yield* library.read;
      if (updated._tag !== "Present") return assert.fail("Missing version matrix");
      const members = join(root, "collection");
      yield* fs.makeDirectory(join(members, "old"), { recursive: true });
      yield* fs.writeFileString(
        join(members, "old", "SKILL.md"),
        "---\nname: old\ndescription: Matrix\n---\nMember\n",
      );
      const request = yield* localImportRequest(members, "2026-10-03T00:00:00.000Z");
      if (Option.isNone(request)) return assert.fail("Missing Collection");
      const imported = yield* library.import.collection(request.value);
      const memberSnapshot = yield* library.read;
      if (memberSnapshot._tag !== "Present") return assert.fail("Missing membership matrix");
      const memberBefore: LibraryState = {
        ...memberSnapshot.state,
        enabled: [{ collection: imported.collection.collection_id }],
      };
      yield* fs.makeDirectory(join(members, "new"));
      yield* fs.writeFileString(
        join(members, "new", "SKILL.md"),
        "---\nname: new\ndescription: Matrix\n---\nMember\n",
      );
      const nextRequest = yield* localImportRequest(members, "2026-10-04T00:00:00.000Z");
      if (Option.isNone(nextRequest)) return assert.fail("Missing added member");
      yield* library.import.collection(nextRequest.value);
      const nextMembers = yield* library.read;
      if (nextMembers._tag !== "Present") return assert.fail("Missing new membership");
      const memberAfter: LibraryState = { ...nextMembers.state, enabled: memberBefore.enabled };
      const richAfter = yield* decodeLibraryState({
        ...rich,
        enabled: [{ skill: rich.skills[0]!.skill_id }],
        repositories: rich.repositories.map((row) => ({
          ...row,
          enabled: [...row.enabled, { skill: rich.skills[1]!.skill_id }],
        })),
        device_skill_selection: {
          ...rich.device_skill_selection,
          mode: "choose",
          enabled: [{ skill: rich.skills[1]!.skill_id }],
        },
      });
      const pairs: Array<{ name: string; before: LibraryState; after: LibraryState }> = [
        { name: "enable", before: base, after: enabled },
        {
          name: "disable",
          before: enabled,
          after: yield* change(enabled, chosen.skill_id, { kind: "global" }, false),
        },
        { name: "repository-add", before: base, after: repo },
        {
          name: "repository-remove",
          before: repo,
          after: yield* change(
            repo,
            chosen.skill_id,
            { kind: "repository", root: repository },
            false,
          ),
        },
        { name: "device-choose", before: deviceBefore, after: deviceAfter },
        { name: "device-mode", before: base, after: deviceBefore },
        { name: "policy", before: policyBefore, after: policyAfter },
        { name: "version", before: base, after: updated.state },
        { name: "membership", before: memberBefore, after: memberAfter },
        { name: "rich", before: rich, after: richAfter },
        { name: "rich-unchanged", before: richAfter, after: richAfter },
      ];
      let comparisons = 0;
      for (const pair of pairs) {
        const before = yield* Schema.encodeEffect(SetupIntent)(setupIntent(pair.before)).pipe(
          Effect.flatMap(Schema.decodeEffect(SetupIntent)),
        );
        const after = yield* Schema.encodeEffect(SetupIntent)(setupIntent(pair.after)).pipe(
          Effect.flatMap(Schema.decodeEffect(SetupIntent)),
        );
        const recorded = yield* prepareSetupChanges(before, after, home);
        const independent = pair.after.skills.find(
          (skill) =>
            !pair.after.enabled.some((item) => "skill" in item && item.skill === skill.skill_id),
        )!;
        const currents: Array<{ name: string; state: LibraryState }> = [
          { name: "after", state: pair.after },
          { name: "before", state: pair.before },
          {
            name: "later",
            state: {
              ...pair.after,
              enabled: [...pair.after.enabled, { skill: independent.skill_id }],
            },
          },
          {
            name: "other-device",
            state: { ...pair.after, device_skill_selection: { mode: "follow-account" } },
          },
        ];
        for (const current of currents) {
          assert.deepStrictEqual(
            inverseSetResult(reverseSetupIntent(current.state, recorded)),
            inverseSetResult(reverseFullSetupIntent(current.state, before, after)),
            `${pair.name}/${current.name}`,
          );
          comparisons++;
        }
      }
      assert.strictEqual(comparisons, 44);
    }).pipe(
      Effect.provide(
        Library.layer({ home, roots: { home: root, configHome: root, overrides: {} } }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
