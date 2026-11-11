import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

it.effect("update imports and removal stay with their owner under another ambient Library", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-operation-owner-" });
    const home = join(root, "a");
    const elsewhere = join(root, "b");
    const source = join(root, "source");
    const path = join(source, "SKILL.md");
    yield* fs.makeDirectory(source);
    yield* fs.writeFileString(path, "---\nname: review\ndescription: Review\n---\nBefore\n");
    const a = yield* Library.Service.pipe(
      Effect.provide(Library.layer({ home, roots: testRoots(home) })),
    );
    const b = yield* Library.Service.pipe(
      Effect.provide(Library.layer({ home: elsewhere, roots: testRoots(elsewhere) })),
    );
    const initial = yield* localImportRequest(source, "2026-11-07T00:00:00.000Z");
    if (Option.isNone(initial)) return assert.fail("Missing source");
    const upstream = { type: "github" as const, owner: "fixture", repository: "review" };
    const before = yield* a.import.collection({ ...initial.value, source: upstream });
    yield* fs.writeFileString(path, "---\nname: review\ndescription: Review\n---\nAfter\n");
    const updated = yield* a
      .update("review", {
        progress: { around: (_stage, operation) => operation },
        updateAuthoredSkills: () => Effect.die("This fixture has no authored workspace"),
        importSource: (upstream, _previousSkillPaths, imports) =>
          Effect.gen(function* () {
            const current = yield* localImportRequest(source, "2026-11-07T01:00:00.000Z");
            if (Option.isNone(current)) return yield* Effect.die("Missing changed source");
            const imported = yield* imports.collection({ ...current.value, source: upstream });
            return {
              snapshot_digest: imported.snapshotDigest,
              collection_version_id: imported.collectionVersionId,
            };
          }),
      })
      .pipe(Effect.provideService(Library.Service, b));
    assert.strictEqual(updated.length, 1);
    const result = updated[0];
    if (result === undefined || !("snapshot_digest" in result))
      return assert.fail(JSON.stringify(result));
    assert.notStrictEqual(result.snapshot_digest, before.snapshotDigest);
    assert.strictEqual((yield* b.read)._tag, "Absent");
    yield* a
      .remove({ query: "review", dryRun: false })
      .pipe(Effect.provideService(Library.Service, b));
    const after = yield* a.read;
    assert.strictEqual(after._tag, "Present");
    if (after._tag === "Present") assert.deepStrictEqual(after.state.skills, []);
    assert.isFalse(yield* fs.exists(elsewhere));
    assert.strictEqual(
      yield* fs.readFileString(path),
      "---\nname: review\ndescription: Review\n---\nAfter\n",
    );
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
