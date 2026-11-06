import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { InvalidLibraryState } from "../src/library/failures.js";
import {
  addSource,
  importSource,
  inspectSource,
  DedicatedInstallerRequired,
} from "../src/library/source.js";
import { skitLayer } from "../src/platform/layer.js";
import { SourceProcess } from "../src/platform/source-process.js";
import { testRoots } from "./helpers/library-store.js";

it.effect(
  "the source owner rejects dedicated installers before preview or import acquisition",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-source-policy-" });
      const request = {
        source: { type: "github" as const, owner: "pbakaus", repository: "impeccable" },
        input: "pbakaus/impeccable",
      };
      yield* Effect.gen(function* () {
        for (const operation of [
          inspectSource(request).pipe(Effect.asVoid),
          importSource(request).pipe(Effect.asVoid),
        ]) {
          const failure = yield* operation.pipe(Effect.flip);
          assert.instanceOf(failure, DedicatedInstallerRequired);
        }
        assert.isFalse(yield* fs.exists(join(home, "state.json")));
      }).pipe(
        Effect.provide(Library.layer({ home, roots: testRoots(home) })),
        Effect.provideService(
          SourceProcess,
          SourceProcess.of({
            run: () => Effect.die("Source acquisition must not start"),
            output: () => Effect.die("Source acquisition must not start"),
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("add keeps its saved import when the optional description report cannot be read", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-add-report-" });
    const home = join(root, "library");
    const source = join(root, "source");
    yield* fs.makeDirectory(source);
    const bytes = "---\nname: review\ndescription: Review carefully\n---\nOriginal content.\n";
    yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
    yield* Effect.gen(function* () {
      const library = yield* Library.Service;
      const report = yield* addSource(home, {
        source: { type: "local", path: source },
        input: source,
      }).pipe(
        Effect.provideService(
          Library.Service,
          Library.Service.of({
            ...library,
            read: Effect.fail(
              new InvalidLibraryState({
                path: join(home, "state.json"),
                detail: "Report read unavailable",
              }),
            ),
          }),
        ),
      );
      assert.strictEqual(report.added.action, "added");
      assert.strictEqual(report.added.skill_ids.length, 1);
      assert.isUndefined(report.descriptionLoad);
      const saved = yield* library.read;
      assert.strictEqual(saved._tag, "Present");
      if (saved._tag === "Present") {
        assert.strictEqual(saved.state.skills.length, 1);
        assert.strictEqual(
          saved.state.collection_versions[0]?.collection_version_id,
          report.added.collection_version_id,
        );
      }
      assert.strictEqual(yield* fs.readFileString(join(source, "SKILL.md")), bytes);
    }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
