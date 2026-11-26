import { syncGuarantee } from "../../../test-support/sync-guarantees.mjs";
import { loadOperations, loadLibrary } from "../src/library/store/library-store.js";

import { libraryDatabasePath } from "../src/library/store/database.js";
import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import { describe, assert, it } from "@effect/vitest";

import { Cause, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { currentLibraryManifest, type LibraryManifest } from "../src/library/library-contracts.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

syncGuarantee(describe, "protectLaterEdits", () => {
  it.effect(
    "Sync verifies its remote receipt, records a data-only program, and publishes and installs through one owner",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-owner-" }),
        );
        const source = join(root, "source");
        const bytes =
          "---\nname: review\ndescription: Sync owner fixture\n---\nOriginal review bytes.\n";
        yield* fs.makeDirectory(source);
        yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
        const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
        if (Option.isNone(request)) return yield* Effect.die("Expected a source");
        const seed = yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const imported = yield* library.import.collection(request.value);
          const skill = imported.skills[0];
          if (!skill) return yield* Effect.die("Expected the review Skill");
          const snapshot = yield* library.read;
          if (snapshot._tag !== "Present") return yield* Effect.die("Expected a Library");
          return {
            manifest: yield* libraryManifestFromLocalState({
              ...snapshot.state,
              enabled: [{ skill: skill.skill_id }],
            }),
            archives: yield* library.content.pack(snapshot),
          };
        }).pipe(
          Effect.provide(
            Library.layer({ home: join(root, "seed"), roots: testRoots(join(root, "seed")) }),
          ),
        );
        const home = join(root, "device");
        const skills = join(root, "skills");
        yield* Effect.gen(function* () {
          const library = yield* Library.Service;
          const base = yield* library.read;
          const staged = yield* library.content.stage(seed.manifest, {
            localArchives: seed.archives,
            registry: { origin: "https://registry.fixture", token: Option.none() },
          });
          const plan = yield* library.plan(
            {
              _tag: "Sync",
              staged,
              acceptedBase: Option.none(),
              deviceSelection: Option.none(),
              pendingOrigin: Option.none(),
              remote: Option.some({
                origin: "https://registry.fixture",
                libraryId: Option.none(),
              }),
            },
            { base },
          );
          const encoded = yield* Schema.encodeEffect(Library.SyncPlan)(plan);
          const portable = yield* Schema.decodeEffect(Library.SyncPlan)(encoded);
          if (!Library.isRemoteSyncPlan(portable))
            return yield* Effect.die("Expected remote Sync review");
          const ancestry = {
            origin: "https://registry.fixture",
            library_id: "library_fixture",
            revision_id: "revision_fixture",
            base_manifest: seed.manifest,
          };
          const receipt = {
            origin: ancestry.origin,
            libraryId: ancestry.library_id,
            revisionId: ancestry.revision_id,
            ancestry,
            manifestDigest: staged.manifestDigest,
          };
          const wrong = yield* Effect.flip(
            library.apply({
              _tag: "ApplySynced",
              plan: portable,
              receipt: { ...receipt, libraryId: "another_library" },
            }),
          );
          assert.strictEqual(wrong._tag, "Library.StalePlan");
          assert.isFalse((yield* inspectLocalLibraryState(join(home))).present);
          assert.isFalse(yield* fs.exists(join(skills, "review")));
          const outcome = yield* library.apply({
            _tag: "ApplySynced",
            plan: portable,
            receipt,
          });
          assert.strictEqual(outcome._tag, "Sync");
          assert.strictEqual(outcome.result.installed, 1);
          assert.deepStrictEqual(outcome.result.enablementIssues, []);
          assert.strictEqual(yield* fs.readFileString(join(skills, "review", "SKILL.md")), bytes);
          const snapshot = yield* library.read;
          if (snapshot._tag !== "Present") return yield* Effect.die("Expected the synced Library");
          assert.deepStrictEqual(snapshot.state.sync_ancestry, ancestry);
          const history = yield* library.history;
          assert.strictEqual(history.events.length, 1);
          assert.isFalse(
            history.operations.some((operation) => operation.operationId === plan.operationId),
          );
          const replay = yield* library
            .apply({ _tag: "ApplySynced", plan: portable, receipt })
            .pipe(Effect.flip);
          assert.strictEqual(replay._tag, "Library.StalePlan");
          const clean = yield* library.plan(
            {
              ...portable.intent,
              acceptedBase: Option.some(ancestry),
              remote: Option.some({
                origin: ancestry.origin,
                libraryId: Option.some(ancestry.library_id),
              }),
            },
            { base: snapshot },
          );
          if (!Library.isRemoteSyncPlan(clean))
            return yield* Effect.die("Expected remote Sync review");
          const repeated = yield* library.apply({ _tag: "ApplySynced", plan: clean, receipt });
          assert.strictEqual(repeated.result.installed, 0);
          assert.strictEqual((yield* library.read).revision, snapshot.revision);
          assert.strictEqual((yield* library.history).events.length, 1);
          assert.strictEqual(yield* fs.readFileString(join(source, "SKILL.md")), bytes);
        }).pipe(
          Effect.provide(
            Library.layer({
              home,
              roots: {
                home: root,
                configHome: root,
                overrides: { codex: [skills] },
              },
            }),
          ),
        );
      }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

  /** A real file-system commit failure leaves the last successfully renamed state on disk. */
  for (const boundary of ["retired", "retired-edited", "published", "installed", "edited"] as const)
    it.effect(
      `Sync startup ${boundary.endsWith("edited") ? `stops on divergent bytes (${boundary})` : `resumes after ${boundary}`} without a remote call`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-replay-" }),
          );
          const source = join(root, "source");
          const bytes = "---\nname: review\ndescription: Replay fixture\n---\nRecorded bytes.\n";
          yield* fs.makeDirectory(source);
          yield* fs.writeFileString(join(source, "SKILL.md"), bytes);
          const request = yield* localImportRequest(source, "2026-11-05T00:00:00.000Z");
          if (Option.isNone(request)) return yield* Effect.die("Missing source");
          const seed = yield* Effect.gen(function* () {
            const library = yield* Library.Service;
            const imported = yield* library.import.collection(request.value);
            const snapshot = yield* library.read;
            if (snapshot._tag !== "Present" || !imported.skills[0])
              return yield* Effect.die("Missing seed");
            return {
              manifest: yield* libraryManifestFromLocalState({
                ...snapshot.state,
                enabled: [{ skill: imported.skills[0].skill_id }],
              }),
              archives: yield* library.content.pack(snapshot),
            };
          }).pipe(
            Effect.provide(
              Library.layer({ home: join(root, "seed"), roots: testRoots(join(root, "seed")) }),
            ),
          );
          const home = join(root, "device");
          const skills = join(root, "skills");
          const layer = Library.layer({
            home,
            roots: {
              home: root,
              configHome: root,
              overrides: { codex: [skills] },
            },
          });
          const syncTarget = (manifest: LibraryManifest, revisionId: string) =>
            Effect.gen(function* () {
              const library = yield* Library.Service;
              const base = yield* library.read;
              const staged = yield* library.content.stage(manifest, {
                localArchives: seed.archives,
                registry: { origin: "https://registry.fixture", token: Option.none() },
              });
              const plan = yield* library.plan(
                {
                  _tag: "Sync",
                  staged,
                  acceptedBase:
                    base._tag === "Present"
                      ? Option.fromUndefinedOr(base.state.sync_ancestry)
                      : Option.none(),
                  deviceSelection: Option.none(),
                  pendingOrigin: Option.none(),
                  remote: Option.some({
                    origin: "https://registry.fixture",
                    libraryId: Option.none(),
                  }),
                },
                { base },
              );
              const ancestry = {
                origin: "https://registry.fixture",
                library_id: "library_fixture",
                revision_id: revisionId,
                base_manifest: manifest,
              };
              if (!Library.isRemoteSyncPlan(plan))
                return yield* Effect.die("Expected remote Sync review");
              return yield* library.apply({
                _tag: "ApplySynced",
                plan,
                receipt: {
                  origin: ancestry.origin,
                  libraryId: ancestry.library_id,
                  revisionId: ancestry.revision_id,
                  manifestDigest: staged.manifestDigest,
                  ancestry,
                },
              });
            });
          const retiring = boundary.startsWith("retired");
          const divergent = boundary.endsWith("edited");
          if (retiring)
            yield* syncTarget(seed.manifest, "revision_previous").pipe(Effect.provide(layer));
          const target = retiring
            ? currentLibraryManifest({
                collections: [],
                skills: [],
                collection_versions: [],
                imports: [],
                snapshot_digests: [],
                enabled: [],
              })
            : seed.manifest;
          let crashed = false;
          const interruptedFs: FileSystem.FileSystem = {
            ...fs,
            chmod: (path, mode) =>
              Effect.gen(function* () {
                if (path === libraryDatabasePath(home)) {
                  const record = (yield* loadOperations(home).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.orDie,
                  )).at(-1);
                  const statuses = record?.steps.map((step) => step.status);
                  const checkpoint = retiring
                    ? ["Done", "Pending", "Pending"]
                    : ["Done", "Done", "Pending"];
                  if (
                    record?._tag === "Pending" &&
                    JSON.stringify(statuses) === JSON.stringify(checkpoint) &&
                    (retiring ||
                      boundary === "published" ||
                      (yield* fs.exists(join(skills, "review", "SKILL.md"))))
                  ) {
                    crashed = true;
                    return yield* Effect.die("Interrupted after Sync checkpoint commit");
                  }
                }
                return yield* fs.chmod(path, mode);
              }),
          };
          const interrupted = yield* Effect.exit(
            syncTarget(target, "revision_fixture").pipe(
              Effect.provide(
                layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, interruptedFs))),
              ),
            ),
          );
          assert.strictEqual(interrupted._tag, "Failure");
          assert.isTrue(
            crashed,
            interrupted._tag === "Failure" ? Cause.pretty(interrupted.cause) : "Unexpected success",
          );
          const saved = yield* loadLibrary(home);
          assert.strictEqual(
            (yield* loadOperations(home).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.orDie,
            )).at(-1)?._tag,
            "Pending",
          );
          assert.strictEqual(saved.sync_ancestry?.revision_id, "revision_fixture");
          const file = join(skills, "review", "SKILL.md");
          if (retiring || boundary === "published") assert.isFalse(yield* fs.exists(file));
          else assert.strictEqual(yield* fs.readFileString(file), bytes);
          const edited = bytes + "User edit after interruption.\n";
          if (divergent) {
            yield* fs.makeDirectory(join(skills, "review"), { recursive: true });
            yield* fs.writeFileString(file, edited);
          }
          // The new process supplies no registry service or receipt: only the recorded program.
          yield* Effect.gen(function* () {
            const library = yield* Library.Service;
            const history = yield* library.history;
            const operation = history.operations.at(-1);
            if (divergent) assert.strictEqual(operation?._tag, "Stopped");
            else assert.deepStrictEqual(history.operations, []);
            if (retiring && !divergent) assert.isFalse(yield* fs.exists(file));
            else assert.strictEqual(yield* fs.readFileString(file), divergent ? edited : bytes);
            if (divergent) {
              assert.strictEqual(library.startup.stopped.length, 1);
              if (operation?._tag === "Stopped")
                assert.strictEqual(operation.reason._tag, "EvidenceDiffers");
            } else {
              assert.strictEqual(library.startup.finished.length, 1);
            }
            assert.strictEqual((yield* library.read)._tag, "Present");
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.provide(skitLayer), Effect.scoped),
    );
});
