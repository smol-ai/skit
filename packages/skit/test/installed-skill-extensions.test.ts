import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";
import { fixture } from "./helpers/library-values.js";
import { JsonObject } from "../src/shared/json.js";
import * as Status from "../src/library/installed-skill-status.js";
import { RecordedInstalledChange, RecordedLibrary } from "../src/library/store/state-schema.js";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { saveLibrary } from "./helpers/library-store.js";
import { skitLayer } from "../src/platform/layer.js";

it.effect(
  "all installed status transitions preserve unknown fields and remove obsolete status evidence",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const copy = state.installed_skills[0]!;
      const conflicted = Status.conflicted(copy, copy.expected_hash, []);
      for (const row of [
        Status.installed(conflicted),
        Status.pending(conflicted),
        Status.suppressed(conflicted, "2026-11-17T00:00:00Z"),
      ]) {
        const value = yield* Schema.decodeUnknownEffect(JsonObject)(row);
        assert.deepStrictEqual(value.extension, { previous: [null, "bytes"] });
        assert.strictEqual(value.installed_skill_id, copy.installed_skill_id);
        assert.isFalse(Object.hasOwn(value, "current_hash"));
        assert.isFalse(Object.hasOwn(value, "conflicts"));
        if (row.status !== "suppressed") assert.isFalse(Object.hasOwn(value, "suppression_reason"));
      }
    }),
);

it.effect("operation row and before/after codecs preserve Installed Skill extensions", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const copy = Status.installed(state.installed_skills[0]!);
    const codec = Schema.fromJsonString(RecordedInstalledChange);
    for (const change of [
      {
        _tag: "Install" as const,
        row: copy,
        invocation: "declared" as const,
        verification: "write" as const,
      },
      { _tag: "Save" as const, row: copy, result: "Unchanged" as const, backUp: false },
    ]) {
      const saved = yield* Schema.decodeEffect(codec)(yield* Schema.encodeEffect(codec)(change));
      if (!("row" in saved)) return yield* Effect.die("Missing row");
      assert.deepStrictEqual(saved.row, copy);
    }
    const before = { installedSkills: [copy] };
    const history = Schema.fromJsonString(RecordedLibrary);
    assert.deepStrictEqual(
      yield* Schema.decodeEffect(history)(yield* Schema.encodeEffect(history)(before)),
      before,
    );
  }),
);

it.effect(
  "installed extensions are refused atomically and a declared version update still completes Apply",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-installed-extensions-" });
      const home = join(root, "library"),
        source = join(root, "source"),
        skills = join(root, "skills");
      yield* fs.makeDirectory(source);
      const text = (body: string) =>
        `---\nname: review\ndescription: Review changes.\n---\n${body}\n`;
      yield* fs.writeFileString(join(source, "SKILL.md"), text("Original"));
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const request = yield* localImportRequest(source, "2026-11-16T00:00:00Z");
        if (Option.isNone(request)) return yield* Effect.die("Missing source");
        const imported = yield* library.import.collection(request.value);
        yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan(
            {
              _tag: "Enabled",
              changes: [
                {
                  _tag: "Enable",
                  subject: { _tag: "Skill", id: imported.skills[0]!.skill_id },
                  where: [{ kind: "global" }],
                },
              ],
            },
            { base: yield* library.read },
          ),
        });
        const before = yield* library.read;
        if (before._tag !== "Present" || !before.state.installed_skills.length)
          return yield* Effect.die("Missing installed copies");
        const extension = { original: [null, "old bytes"], future: { untouched: true } };
        const originalBytes = yield* fs.readFileString(
          join(before.state.installed_skills[0]!.path, "SKILL.md"),
        );
        const refused = yield* Effect.result(
          saveLibrary(home, {
            ...before.state,
            installed_skills: before.state.installed_skills.map((row) => ({ ...row, extension })),
          }),
        );
        assert.strictEqual(refused._tag, "Failure");
        assert.deepStrictEqual(yield* library.read, before);
        assert.strictEqual(
          yield* fs.readFileString(join(before.state.installed_skills[0]!.path, "SKILL.md")),
          originalBytes,
        );
        yield* fs.writeFileString(join(source, "SKILL.md"), text("Updated"));
        const update = yield* localImportRequest(source, "2026-11-17T00:00:00Z");
        if (Option.isNone(update)) return yield* Effect.die("Missing updated source");
        yield* library.import.collection(update.value);
        const outcome = yield* library.apply({
          _tag: "Apply",
          plan: yield* library.plan({ _tag: "Update" }, { base: yield* library.read }),
        });
        assert.strictEqual(outcome.result._tag, "Applied");
        const after = yield* library.read;
        if (after._tag !== "Present") return yield* Effect.die("Missing Library");
        for (const row of after.state.installed_skills) {
          const value = yield* Schema.decodeUnknownEffect(JsonObject)(row);
          assert.isFalse(Object.hasOwn(value, "extension"));
          assert.strictEqual(row.status, "installed");
          assert.isFalse(
            before.state.installed_skills.some(
              (prior) => prior.skill_version_id === row.skill_version_id,
            ),
          );
          assert.include(yield* fs.readFileString(join(row.path, "SKILL.md")), "Updated");
        }
      }).pipe(
        Effect.provide(
          Library.layer({
            home,
            roots: { home: root, configHome: join(root, "config"), overrides: { codex: [skills] } },
          }),
        ),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
