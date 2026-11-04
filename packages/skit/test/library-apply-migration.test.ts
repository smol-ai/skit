import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../src/library/library.js";
import { InstalledSkill } from "../src/library/device-state.js";
import { OperationStatus } from "../src/library/store/state-schema.js";
import { loadLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { skitLayer } from "../src/platform/layer.js";

const fixture = Effect.fn("test.applyMigration.fixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-apply-migration-" });
  const original = yield* fs.readFileString(
    fileURLToPath(new URL(`./fixtures/library-state/v12-apply-${name}.json`, import.meta.url)),
  );
  yield* fs.writeFileString(join(home, "state.json"), original);
  return { fs, home, original };
});

for (const name of ["prepared", "completed"] as const)
  it.effect(
    `v12 ${name} Apply retains exact rows and evidence without touching installed files`,
    () =>
      Effect.gen(function* () {
        const { fs, home, original } = yield* fixture(name);
        const checked: FileSystem.FileSystem = {
          ...fs,
          makeDirectory: (path, options) =>
            resolve(path).startsWith(resolve(home))
              ? fs.makeDirectory(path, options)
              : Effect.die(`Migration tried to create ${path}`),
          rename: (from, to) =>
            resolve(to).startsWith(resolve(home))
              ? fs.rename(from, to)
              : Effect.die(`Migration tried to move ${to}`),
        };
        yield* migrateLocalLibraryState(home).pipe(
          Effect.provideService(FileSystem.FileSystem, checked),
        );
        const state = yield* loadLibrary(home);
        assert.strictEqual(state.schemaVersion, 13);
        const old = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Struct({ installed_skills: Schema.Array(InstalledSkill) })),
        )(original);
        assert.deepStrictEqual(state.installed_skills, old.installed_skills);
        const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
          state.operations,
        );
        const operation = operations.at(-1);
        assert.strictEqual(operation?._tag, "Pending");
        const step = operation?.steps[0]?.step;
        if (step?._tag !== "Apply") return assert.fail("Missing typed Apply");
        assert.strictEqual(step.phase._tag, name === "completed" ? "Done" : "Pending");
        const install = step.changes.find((change) => change._tag === "Install");
        if (install?._tag !== "Install") return assert.fail("Missing fixed install");
        assert.strictEqual(
          install.row.expected_hash,
          "sha256:2c8069d55ad4251637a2c8694fbe2d4312574176fe089c594fc1780ef90647be",
        );
        assert.strictEqual(install.row.path, "/fixtures/library-apply/skills/review");
        assert.strictEqual(
          install.row.installed_skill_id,
          old.installed_skills[0]?.installed_skill_id,
        );
        assert.isFalse(Object.hasOwn(step, "reviewed"));
        assert.isFalse(Object.hasOwn(step, "ids"));
        assert.isFalse(Object.hasOwn(step, "expected"));
        assert.isFalse(Object.hasOwn(step.next, "installed_skills"));
        const backup = (yield* fs.readDirectory(home)).find((name) =>
          name.startsWith("state.json.v12.backup-"),
        );
        assert.isDefined(backup);
        const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
        assert.deepStrictEqual(
          yield* json(yield* fs.readFileString(join(home, backup!))),
          yield* json(original),
        );
        const saved = yield* fs.readFileString(join(home, "state.json"));
        yield* migrateLocalLibraryState(home);
        assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), saved);
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("an unprepared v12 install is retained and reported Stopped rather than guessed", () =>
  Effect.gen(function* () {
    const { fs, home } = yield* fixture("unprepared");
    const startup = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      return library.startup;
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
    assert.deepStrictEqual(startup.finished, []);
    const stopped = startup.stopped[0];
    assert.isDefined(stopped);
    assert.strictEqual(stopped?.reason._tag, "StepFailed");
    const step = stopped?.steps[0]?.step;
    if (step?._tag !== "LegacyApply") return assert.fail("Legacy record was discarded");
    assert.include(step.detail, "no recorded install hash");
    assert.isTrue(JSON.stringify(step.document).includes('"reviewed"'));
    assert.isFalse(yield* fs.exists(join(home, "skills")));
    assert.deepStrictEqual((yield* loadLibrary(home)).installed_skills, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a v12 pending setup without a recorded batch stops instead of replanning", () =>
  Effect.gen(function* () {
    const { fs, home, original } = yield* fixture("unprepared");
    yield* fs.writeFileString(
      join(home, "state.json"),
      original.replace(
        '"_tag": "Apply",',
        '"_tag": "Update", "changes": [], "versionChoices": [], "importedAt": "2026-11-05T00:00:00.000Z",',
      ),
    );
    const startup = yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      return library.startup;
    }).pipe(Effect.provide(Library.layer({ home, routing: { _tag: "None" } })));
    assert.deepStrictEqual(startup.finished, []);
    const step = startup.stopped[0]?.steps[0]?.step;
    if (step?._tag !== "LegacyApply") return assert.fail("Pending legacy setup was not retained");
    assert.include(step.detail, "no recorded installed changes");
    assert.deepStrictEqual((yield* loadLibrary(home)).installed_skills, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("inconsistent v12 installed identities are retained and stopped", () =>
  Effect.gen(function* () {
    const { fs, home, original } = yield* fixture("prepared");
    const changed = original.replaceAll(
      '"id": "proj_01m6mehz2zeh0bgey650p6gq06"',
      '"id": "proj_01m6mehz81eh0bgf2ft6rx3y9a"',
    );
    assert.notStrictEqual(changed, original);
    yield* fs.writeFileString(join(home, "state.json"), changed);
    yield* migrateLocalLibraryState(home);
    const operations = yield* Schema.decodeUnknownEffect(Schema.Array(OperationStatus))(
      (yield* loadLibrary(home)).operations,
    );
    const operation = operations.at(-1);
    assert.strictEqual(operation?._tag, "Stopped");
    const step = operation?.steps[0]?.step;
    if (step?._tag !== "LegacyApply")
      return assert.fail("Inconsistent legacy record was discarded");
    assert.include(step.detail, "inconsistent installed identity");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
