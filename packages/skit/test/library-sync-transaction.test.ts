import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Result } from "effect";
import { SqlClient } from "effect/sql";
import { join } from "node:path";
import * as Library from "../src/library/library.js";
import { libraryManifestFromLocalState } from "../src/library/library-state.js";
import { localImportRequest } from "../src/library/setup/local-import.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { skitLayer } from "../src/platform/layer.js";
import { testRoots } from "./helpers/library-store.js";

for (const refuse of [false, true])
  it.effect(`sync rows and pending work share one transaction (refused=${refuse})`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-transaction-" });
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
        const imported = yield* library.import.collection(request.value);
        const skill = imported.skills[0];
        if (!skill) return yield* Effect.die("Missing Skill");
        const before = yield* library.read;
        if (before._tag !== "Present") return yield* Effect.die("Missing Library");
        const history = yield* library.history;
        const remote = {
          library_id: "transaction-library",
          revision_id: "transaction-revision",
          manifest: yield* libraryManifestFromLocalState({
            ...before.state,
            enabled: [{ skill: skill.skill_id }],
          }),
        };
        yield* withLibraryDatabase(
          libraryDatabasePath(home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            // The pending program must already exist on the SAME connection when merged rows appear.
            yield* sql`CREATE TRIGGER require_pending_sync BEFORE INSERT ON library_enabled
            WHEN NOT EXISTS (SELECT 1 FROM library_operations WHERE kind = 'sync' AND json_extract(document, '$._tag') = 'Pending')
            BEGIN SELECT RAISE(ABORT, 'merged rows without pending work'); END`;
            if (refuse)
              yield* sql`CREATE TRIGGER refuse_merged_rows AFTER INSERT ON library_enabled
              BEGIN SELECT RAISE(ABORT, 'fixture refuses merged rows'); END`;
          }),
        );
        const result = yield* library
          .sync(
            { origin: "https://registry.test", apply: true },
            {
              read: Effect.succeed(remote),
              upload: () => Effect.void,
              download: () => Effect.die("No download expected"),
              write: () => Effect.die("Remote already holds the desired Library"),
            },
          )
          .pipe(Effect.result);
        if (refuse) {
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "LibrarySqlError");
          assert.deepStrictEqual(yield* library.read, before);
          assert.deepStrictEqual(yield* library.history, history);
        } else {
          assert.isTrue(Result.isSuccess(result));
          const after = yield* library.read;
          if (after._tag !== "Present") return yield* Effect.die("Missing merged Library");
          assert.deepStrictEqual(after.state.enabled, remote.manifest.enabled);
          assert.strictEqual(after.state.sync_ancestry?.revision_id, remote.revision_id);
        }
      }).pipe(Effect.provide(Library.layer({ home, roots: testRoots(home) })));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
