import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { edit } from "../src/library/library-edit.js";
import { decodeLibraryState, libraryStateRevision } from "../src/library/library-state.js";
import { compileApply, prepareApplyState } from "../src/library/internal/operations/program.js";
import { InstalledApply } from "../src/library/store/state-schema.js";
import * as Library from "../src/library/library.js";
import { skitLayer } from "../src/platform/layer.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
it.effect("Remove is repeatable across working directories with ordered repository lists", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const collection = state.collections[0];
    const skill = state.skills[1];
    assert.ok(collection);
    assert.ok(skill);
    const base = {
      ...state,
      installed_skills: [],
      repositories: [
        {
          root: "/repo-one",
          enabled: [{ collection: collection.collection_id }, { skill: skill.skill_id }],
        },
        {
          root: "/repo-two",
          enabled: [{ skill: skill.skill_id }, { collection: collection.collection_id }],
        },
      ],
    };
    yield* decodeLibraryState(base);
    const revision = libraryStateRevision(base);
    const fs = yield* FileSystem.FileSystem;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "skit-remove-repeat-" });
    const input = join(temp, "state.json");
    yield* fs.writeFileString(input, JSON.stringify(base));
    const url = pathToFileURL(join(packageRoot, "dist/library/library-edit.js")).href;
    const platform = pathToFileURL(join(packageRoot, "dist/platform/layer.js")).href;
    const effect = pathToFileURL(join(packageRoot, "node_modules/effect/dist/index.js")).href;
    const script = `import { readFileSync } from 'node:fs'; import { Effect } from ${JSON.stringify(effect)}; import { edit } from ${JSON.stringify(url)}; import { skitLayer } from ${JSON.stringify(platform)}; const state=JSON.parse(readFileSync(process.argv[1],'utf8')); const before=JSON.stringify(state); const result=await Effect.runPromise(edit(state,{_tag:'Remove',collectionId:process.argv[2]}).pipe(Effect.provide(skitLayer))); process.stdout.write(JSON.stringify({next:result.next,unchanged:before===JSON.stringify(state)}));`;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const results = [];
    for (const cwd of ["/private/tmp", packageRoot]) {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          ["--input-type=module", "-e", script, input, collection.collection_id],
          { cwd, stdout: "pipe", stderr: "inherit" },
        ),
      );
      const text = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runCollect,
        Effect.map((chunks) => chunks.join("")),
      );
      assert.strictEqual(yield* child.exitCode, 0);
      results.push(
        yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ next: Schema.Unknown, unchanged: Schema.Boolean })),
        )(text),
      );
    }
    assert.deepStrictEqual(results[0], results[1]);
    assert.isTrue(results[0]?.unchanged);
    const next = yield* decodeLibraryState(results[0]?.next);
    assert.isFalse(
      next.collections.some((item) => item.collection_id === collection.collection_id),
    );
    assert.strictEqual(next.repositories.length, 2);
    assert.deepStrictEqual(
      next.repositories.map((repo) => repo.enabled),
      [[{ skill: skill.skill_id }], [{ skill: skill.skill_id }]],
    );
    assert.strictEqual(libraryStateRevision(base), revision);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("Enabled stores small old and new fields on the fixture and fifty repositories", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const skill = state.skills[0];
    assert.ok(skill);
    const measurements = [];
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-apply-fields-" });
    const library = yield* Library.Service.pipe(
      Effect.provide(Library.layer({ home, roots: { home, configHome: home, overrides: {} } })),
    );
    const template = yield* library.plan({ _tag: "Install" }, { base: yield* library.read });
    for (const count of [1, 50]) {
      let base = yield* decodeLibraryState({
        ...state,
        repositories: Array.from({ length: count }, (_, index) => ({
          ...state.repositories[0],
          root: "/repo-" + index,
        })),
      });
      for (const enabled of [true, false]) {
        const intent: Library.Intent = {
          _tag: "Enabled",
          changes: [
            {
              _tag: enabled ? "Enable" : "Disable",
              subject: { _tag: "Skill", id: skill.skill_id },
              where: [{ kind: "repository", root: "/repo-0" }],
              ...(enabled ? { invocation: "implicit" } : {}),
            },
          ],
        };
        const { next } = yield* edit(base, intent);
        const step = yield* compileApply(
          { ...template, _tag: "Enabled", intent, next, changes: [], folders: [], routes: [] },
          base,
          new Map(),
          { active: [], destinations: [], readable: [] },
          home,
        );
        const roundTrip = yield* Schema.decodeEffect(Schema.fromJsonString(InstalledApply))(
          yield* Schema.encodeEffect(Schema.fromJsonString(InstalledApply))(step),
        );
        assert.deepStrictEqual(yield* prepareApplyState(roundTrip, next, "before", home), base);
        assert.deepStrictEqual(yield* prepareApplyState(roundTrip, base, "after", home), next);
        assert.strictEqual(roundTrip.bodyChange?._tag, "Enabled");
        if (roundTrip.bodyChange?._tag !== "Enabled") return assert.fail("Missing fields");
        assert.deepStrictEqual(
          roundTrip.bodyChange.fields.map((field) => field.field),
          enabled ? ["repositories"] : ["repositories", "invocation_policies"],
        );
        const bytes = Buffer.byteLength(JSON.stringify(roundTrip.bodyChange));
        assert.isBelow(bytes, 25_000);
        measurements.push({
          repositories: count,
          change: enabled ? "enable-policy" : "disable",
          fieldsBytes: bytes,
          libraryBytes: Buffer.byteLength(JSON.stringify(base)),
        });
        base = next;
      }
    }
    yield* fs.writeFileString(
      "/private/tmp/skit-apply-field-sizes.json",
      JSON.stringify(measurements, null, 2),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
