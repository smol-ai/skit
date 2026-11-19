import { inspectLocalLibraryState } from "../src/library/store/state-file.js";
import {
  emptyLibraryState,
  decodeLibraryState,
  libraryManifestFromLocalState,
} from "../src/library/library-state.js";
import { SyncAncestry } from "../src/library/store/state-fields.js";
import { sha256Hash } from "../src/shared/hash.js";
import { normalizeLibraryManifest } from "../src/library/manifest.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as Library from "../src/library/library.js";
import { fixture } from "./helpers/library-values.js";
import { saveLibrary, testRoots } from "./helpers/library-store.js";
import { skitLayer } from "../src/platform/layer.js";
import { canonicalJson } from "../src/shared/json.js";
import { makeOperationId } from "../src/library/entity-ids.js";
import { snapshotOf } from "../src/library/snapshot.js";
import {
  LibraryWriter,
  loadLibrary,
  loadOperations,
  writeLibrary,
} from "../src/library/store/library-store.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { prepareLibraryDifference } from "../src/library/store/difference.js";
import { recordedLibrary } from "../src/library/store/intent.js";
import { OperationStatus, StepRouting } from "../src/library/store/state-schema.js";

for (const kind of ["Sync", "Undo"] as const) {
  it.effect(kind + " recovery refuses a live Library matching neither side before file work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-difference-recovery-" });
      const { state } = yield* fixture;
      const after = { ...state, enabled: [{ skill: state.skills[0]!.skill_id }] };
      const difference = yield* prepareLibraryDifference(state, after, home);
      const routing = yield* StepRouting.makeEffect({ active: [], destinations: [], readable: [] });
      const step =
        kind === "Sync"
          ? {
              _tag: "Sync" as const,
              phase: "retire" as const,
              program: {
                difference,
                routing,
                retire: [],
                drop: [],
                manifestDigest: state.skills[0]!.versions[0]!.source_hash,
                receiptAccepted: false,
                folders: [],
                issues: [],
              },
            }
          : {
              _tag: "Undo" as const,
              program: {
                difference,
                operationId: makeOperationId(),
                backupId: "b56f90ec-d27f-41cf-805f-6234fe1c2810",
                files: [],
                paths: [],
                sources: [],
                sourceImports: [],
                actions: [],
                preserve: [],
                preserved: true,
              },
            };
      const pending = OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        before: recordedLibrary(state),
        steps: [{ step, before: [], after: [], status: "Pending" }],
      });
      yield* saveLibrary(home, state);
      const changed = { ...state, probeExtension: { user: ["new", null] } };
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          yield* writer.recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            kind === "Sync" ? "sync" : "undo",
          );
          yield* writer.save(changed, state);
        }),
      );
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, []);
        assert.strictEqual(library.startup.stopped.length, 1);
        assert.strictEqual(
          library.startup.stopped[0]?.reason._tag,
          kind === "Sync" ? "EvidenceDiffers" : "StepFailed",
        );
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(changed));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

  it.effect("store refuses an old running " + kind + " record without rewriting its bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-old-operation-" });
      const { state } = yield* fixture;
      yield* saveLibrary(home, state);
      const operationId = makeOperationId();
      const routing = yield* StepRouting.makeEffect({ active: [], destinations: [], readable: [] });
      const program =
        kind === "Sync"
          ? {
              before: state,
              after: state,
              routing,
              retire: [],
              drop: [],
              manifestDigest: state.skills[0]!.versions[0]!.source_hash,
              receipt: Option.none(),
              folders: [],
              issues: [],
            }
          : {
              before: state,
              after: state,
              operationId: makeOperationId(),
              backupId: "b56f90ec-d27f-41cf-805f-6234fe1c2810",
              files: [],
              paths: [],
              sources: [],
              sourceImports: [],
              actions: [],
              preserve: [],
              preserved: true,
            };
      const document = JSON.stringify({
        _tag: "Pending",
        operationId,
        before: recordedLibrary(state),
        steps: [
          {
            step: { _tag: kind, ...(kind === "Sync" ? { phase: "retire" } : {}), program },
            before: [],
            after: [],
            status: "Pending",
          },
        ],
      });
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO library_operations (position,operation_id,kind,document) VALUES (0,${operationId},${kind === "Sync" ? "sync" : "undo"},${document})`;
        }),
      );
      const result = yield* Effect.flip(loadOperations(home));
      assert.strictEqual(result._tag, "InvalidLibraryState");
      yield* withLibraryDatabase(
        libraryDatabasePath(home),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            document: string;
          }>`SELECT document FROM library_operations WHERE operation_id=${operationId}`;
          assert.strictEqual(rows[0]?.document, document);
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect(
  "Sync still refuses a receipt whose declared fields differ from the exact after ancestry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-receipt-contract-" });
      const before = emptyLibraryState();
      const manifest = yield* libraryManifestFromLocalState(before);
      const ancestry = {
        origin: "https://registry.test",
        library_id: "library",
        revision_id: "revision",
        base_manifest: manifest,
        extension: { mustRemain: true },
      };
      const after = yield* decodeLibraryState({ ...before, sync_ancestry: ancestry });
      const receipt = yield* Schema.decodeEffect(SyncAncestry)(ancestry);
      assert.notStrictEqual(canonicalJson(receipt), canonicalJson(after.sync_ancestry));
      const difference = yield* prepareLibraryDifference(before, after, home);
      const manifestDigest = yield* sha256Hash(
        new TextEncoder().encode(canonicalJson(normalizeLibraryManifest(manifest))),
      );
      const routing = yield* StepRouting.makeEffect({ active: [], destinations: [], readable: [] });
      const pending = OperationStatus.cases.Pending.make({
        operationId: makeOperationId(),
        before: recordedLibrary(before),
        steps: [
          {
            step: {
              _tag: "Sync",
              phase: "retire",
              program: {
                difference,
                routing,
                retire: [],
                drop: [],
                manifestDigest,
                receiptAccepted: true,
                folders: [],
                issues: [],
              },
            },
            before: [],
            after: [],
            status: "Pending",
          },
        ],
      });
      yield* saveLibrary(home, before);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          yield* (yield* LibraryWriter).recordOperation(
            pending,
            snapshotOf(yield* inspectLocalLibraryState(home)),
            "sync",
          );
        }),
      );
      yield* Effect.gen(function* () {
        const library = yield* Library.Service;
        assert.deepStrictEqual(library.startup.finished, []);
        assert.strictEqual(library.startup.stopped[0]?.reason._tag, "EvidenceDiffers");
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
      assert.strictEqual(canonicalJson(yield* loadLibrary(home)), canonicalJson(before));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
