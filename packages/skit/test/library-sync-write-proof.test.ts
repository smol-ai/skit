import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result, Schema } from "effect";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { canonicalJson } from "../src/shared/json.js";
import { currentLibraryManifest, type SnapshotArchive } from "../src/library/library-contracts.js";
import type { RemoteLibrary } from "../src/library/internal/sync/library-sync.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";
import { StalePlan } from "../src/library/plan-failures.js";

for (const outcome of [
  "accepted-without-response",
  "concurrent-local-edit",
  "concurrent-sync",
  "different-manifest",
  "different-known-field",
  "changing-head",
  "different-library",
  "unreadable-head",
  "incorrect-success-response",
] as const)
  it.effect(`Library sync proves remote acceptance: ${outcome}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-proof-" });
      const source = join(home, "source");
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: review\ndescription: review\n---\nReview\n",
      );
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        const request = yield* localImportRequest(source, "2026-11-17T00:00:00Z");
        if (Option.isNone(request)) return yield* Effect.die("Missing source");
        yield* library.import.collection(request.value);
        const before = yield* library.read;
        if (before._tag !== "Present") return yield* Effect.die("Missing imported Library");
        const beforeArchives = yield* library.content.pack(before);
        const beforeBytes = yield* fs.readFile(join(source, "SKILL.md"));
        const localManifest = yield* libraryManifestFromLocalState(before.state);
        let head: RemoteLibrary = {
          library_id: "library-proof",
          revision_id: "revision-before",
          manifest: currentLibraryManifest({
            collections: [],
            skills: [],
            collection_versions: [],
            imports: [],
            enabled: [],
            snapshot_digests: [],
          }),
        };
        let fetched: RemoteLibrary | undefined;
        let attemptedBase: RemoteLibrary | undefined;
        let reads = 0;
        let writes = 0;
        const lostResponse = { _tag: "LostResponse" };
        const result = yield* library
          .sync(
            { origin: "https://registry.test", apply: true },
            {
              read: Effect.gen(function* () {
                reads++;
                if (reads > 1 && outcome === "unreadable-head")
                  return yield* Effect.fail({ _tag: "ReadFailed" });
                fetched = structuredClone(head);
                return structuredClone(head);
              }),
              upload: () => Effect.void,
              download: () => Effect.die("No download expected"),
              write: (expected, manifest) =>
                Effect.gen(function* () {
                  attemptedBase = structuredClone(fetched);
                  writes++;
                  assert.strictEqual(expected, head.revision_id);
                  head = {
                    library_id:
                      outcome === "different-library" ? "another-library" : head.library_id,
                    revision_id: `revision-after-${writes}`,
                    manifest:
                      outcome === "changing-head" ? head.manifest : structuredClone(manifest),
                  };
                  if (outcome === "concurrent-local-edit") {
                    const later = join(home, "later");
                    yield* fs.makeDirectory(later);
                    yield* fs.writeFileString(
                      join(later, "SKILL.md"),
                      "---\nname: later\ndescription: later\n---\nLater\n",
                    );
                    const imported = yield* localImportRequest(later, "2026-11-17T00:01:00Z");
                    if (Option.isNone(imported)) return yield* Effect.die("Missing later source");
                    yield* library.import.collection(imported.value);
                  }
                  if (outcome === "concurrent-sync") {
                    yield* library.sync(
                      { origin: "https://registry.test", apply: true },
                      {
                        read: Effect.succeed({ ...head, revision_id: "concurrent-revision" }),
                        upload: () => Effect.void,
                        download: () => Effect.die("No download expected"),
                        write: () => Effect.die("No write expected for the matching head"),
                      },
                    );
                    return head;
                  }
                  if (outcome === "different-manifest" || outcome === "incorrect-success-response")
                    // Even an extension field must match what was actually sent.
                    Reflect.set(head.manifest, "remote_extension", { changed: true });
                  if (outcome === "different-known-field")
                    Reflect.set(head.manifest.collections[0]!, "label", "concurrent label");
                  if (outcome === "incorrect-success-response") return head;
                  return yield* Effect.fail(lostResponse);
                }),
            },
          )
          .pipe(Effect.result);
        assert.strictEqual(writes, outcome === "changing-head" ? 3 : 1);
        assert.strictEqual(
          reads,
          outcome === "incorrect-success-response" || outcome === "concurrent-sync"
            ? 1
            : outcome === "different-known-field"
              ? 3
              : outcome === "changing-head"
                ? 6
                : 2,
        );
        if (outcome === "accepted-without-response" || outcome === "concurrent-local-edit") {
          assert.isTrue(Result.isSuccess(result));
          const after = yield* library.read;
          assert.strictEqual(after._tag, "Present");
          if (after._tag === "Present") {
            assert.strictEqual(after.state.sync_ancestry?.revision_id, head.revision_id);
            assert.deepStrictEqual(after.state.sync_ancestry?.base_manifest, head.manifest);
            assert.strictEqual(
              after.state.collections.length,
              outcome === "concurrent-local-edit" ? 2 : 1,
            );
          }
        } else if (outcome === "different-known-field") {
          assert.isTrue(Result.isSuccess(result));
          if (Result.isSuccess(result)) assert.strictEqual(result.success.status, "conflicted");
        } else if (outcome === "concurrent-sync") {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result) && Schema.is(StalePlan)(result.failure))
            assert.deepStrictEqual(result.failure.reason, { _tag: "SyncChanged", part: "base" });
          const after = yield* library.read;
          assert.strictEqual(
            after._tag === "Present" ? after.state.sync_ancestry?.revision_id : undefined,
            "concurrent-revision",
          );
        } else {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            if (outcome === "incorrect-success-response") {
              assert.strictEqual(result.failure._tag, "Library.StalePlan");
              if (Schema.is(StalePlan)(result.failure))
                assert.deepStrictEqual(result.failure.reason, {
                  _tag: "SyncPlanInvalid",
                  reason: "receipt-mismatch",
                });
            } else assert.strictEqual(result.failure, lostResponse);
          }
        }
        if (
          outcome !== "accepted-without-response" &&
          outcome !== "concurrent-local-edit" &&
          outcome !== "concurrent-sync"
        ) {
          const after = yield* library.read;
          if (after._tag !== "Present") return yield* Effect.die("Lost local Library");
          const { sync_ancestry: _beforeBase, ...beforeContent } = before.state;
          const { sync_ancestry: savedBase, ...afterContent } = after.state;
          assert.deepStrictEqual(afterContent, beforeContent);
          assert.strictEqual(canonicalJson(afterContent), canonicalJson(beforeContent));
          assert.deepStrictEqual(yield* library.content.pack(after), beforeArchives);
          assert.deepStrictEqual(yield* fs.readFile(join(source, "SKILL.md")), beforeBytes);
          const base = attemptedBase;
          if (!base) return yield* Effect.die("Missing fetched base for attempted upload");
          assert.deepStrictEqual(savedBase, {
            origin: "https://registry.test",
            library_id: base.library_id,
            revision_id: base.revision_id,
            base_manifest: base.manifest,
          });
          assert.notStrictEqual(
            canonicalJson(savedBase?.base_manifest),
            canonicalJson(localManifest),
          );
          // Recover transport availability with the last verified head still current. Every local
          // change must still be pending: the failed target was never an acknowledged merge base.
          let retryWrites = 0;
          const uploaded: SnapshotArchive[] = [];
          const retried = yield* library.sync(
            { origin: "https://registry.test", apply: true },
            {
              read: Effect.succeed(structuredClone(base)),
              upload: (archive) =>
                Effect.sync(() => {
                  uploaded.push(archive);
                }),
              download: () => Effect.die("No download expected on retry"),
              write: (expected, manifest) =>
                Effect.sync(() => {
                  retryWrites++;
                  assert.strictEqual(expected, base.revision_id);
                  assert.deepStrictEqual(manifest, localManifest);
                  return { library_id: base.library_id, revision_id: "revision-retry", manifest };
                }),
            },
          );
          assert.strictEqual(retried.status, "merged");
          assert.strictEqual(retryWrites, 1);
          assert.deepStrictEqual(uploaded, beforeArchives);
          const recovered = yield* library.read;
          if (recovered._tag !== "Present") return yield* Effect.die("Missing recovered Library");
          assert.deepStrictEqual(recovered.state.sync_ancestry?.base_manifest, localManifest);
          assert.strictEqual(recovered.state.sync_ancestry?.revision_id, "revision-retry");
          assert.deepStrictEqual(yield* library.content.pack(recovered), beforeArchives);
        }
        return result;
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
