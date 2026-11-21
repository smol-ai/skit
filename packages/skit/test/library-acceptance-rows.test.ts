import { saveLibrary } from "./helpers/library-store.js";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { SqlClient } from "effect/sql";
import { declaredFixture as fixture } from "./helpers/library-values.js";
import { skitLayer } from "../src/platform/layer.js";
import { LibraryWriter, loadLibrary, writeLibrary } from "../src/library/store/library-store.js";
import { migrateLocalLibraryState } from "../src/library/store/state-file.js";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";
import { libraryStateRevision } from "../src/library/library-state.js";
import { Hash } from "../src/shared/hash.js";
import { makeSkillVersionId } from "../src/library/entity-ids.js";

const prepared = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-acceptance-rows-" });
  const { state } = yield* fixture;
  yield* saveLibrary(home, state);
  yield* migrateLocalLibraryState(home);
  const prior = state.assessmentAcceptances?.[0];
  if (!prior) return yield* Effect.die("Missing acceptance");
  const acceptance = {
    ...prior,
    acceptedAt: "2026-11-17T00:00:00Z",
  };
  return { home, state, acceptance, path: libraryDatabasePath(home) };
});

it.effect(
  "acceptance, revision and audit commit together, preserving duplicate evidence and every unknown field",
  () =>
    Effect.gen(function* () {
      const { home, state, acceptance, path } = yield* prepared;
      const history = yield* readLibraryAudit(home);
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          yield* withLibraryDatabase(
            path,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const original =
                yield* sql`SELECT rowid,* FROM library_assessment_acceptances ORDER BY rowid`;
              const [before] = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
              const accepted = yield* writer.saveAcceptance(acceptance, revision);
              assert.strictEqual(accepted, revision + 1);
              const [after] = yield* sql<{ count: number }>`SELECT total_changes() AS count`;
              assert.strictEqual(after!.count - before!.count, 4);
              assert.strictEqual(yield* writer.saveAcceptance(acceptance, accepted), accepted + 1);
              const rows =
                yield* sql`SELECT rowid,* FROM library_assessment_acceptances ORDER BY rowid`;
              assert.deepStrictEqual(rows.slice(0, original.length), original);
              assert.strictEqual(rows.length, original.length + 2);
            }),
          );
        }),
      );
      assert.strictEqual(
        libraryStateRevision(yield* loadLibrary(home)),
        libraryStateRevision({
          ...state,
          assessmentAcceptances: [...state.assessmentAcceptances!, acceptance, acceptance],
        }),
      );
      const afterHistory = yield* readLibraryAudit(home);
      assert.deepStrictEqual(afterHistory.slice(0, history.length), history);
      assert.strictEqual(afterHistory.length, history.length + 1);
      assert.deepStrictEqual(
        afterHistory.at(-1)?.changes,
        [0, 1].map(() => ({
          entity: "version",
          id: acceptance.skill_version_id,
          action: "security-finding-accepted",
          digest: acceptance.fingerprint,
          after: JSON.stringify(acceptance),
        })),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("acceptance insertion needs no installed, scan or ancestry tables", () =>
  Effect.gen(function* () {
    const { home, acceptance, path } = yield* prepared;
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE library_installed_skills`;
        yield* sql`DROP TABLE library_inventory`;
        yield* sql`DROP TABLE library_sync_base`;
        yield* sql`DROP TABLE library_sync`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        assert.strictEqual(yield* writer.saveAcceptance(acceptance, revision), revision + 1);
      }),
    );
    assert.strictEqual((yield* Effect.flip(loadLibrary(home)))._tag, "LibrarySqlError");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "acceptance insertion refuses stale revisions, missing versions and mismatched artifact hashes",
  () =>
    Effect.gen(function* () {
      const { home, acceptance } = yield* prepared;
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const before = yield* writer.revision;
          const revision = yield* writer.saveAcceptance(acceptance, before);
          const saved = yield* loadLibrary(home);
          assert.strictEqual(
            (yield* Effect.flip(writer.saveAcceptance(acceptance, before)))._tag,
            "LibraryChanged",
          );
          assert.strictEqual(
            (yield* Effect.flip(
              writer.saveAcceptance(
                { ...acceptance, skill_version_id: makeSkillVersionId() },
                revision,
              ),
            ))._tag,
            "LibraryChanged",
          );
          const hash = yield* Hash.makeEffect(`sha256:${"f".repeat(64)}`);
          assert.strictEqual(
            (yield* Effect.flip(
              writer.saveAcceptance({ ...acceptance, artifactContentHash: hash }, revision),
            ))._tag,
            "LibraryChanged",
          );
          assert.strictEqual(yield* writer.revision, revision);
          assert.strictEqual(
            libraryStateRevision(yield* loadLibrary(home)),
            libraryStateRevision(saved),
          );
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a refused revision write rolls back the new acceptance without altering earlier evidence",
  () =>
    Effect.gen(function* () {
      const { home, state, acceptance, path } = yield* prepared;
      yield* withLibraryDatabase(
        path,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_acceptance_revision BEFORE UPDATE ON library_device BEGIN SELECT RAISE(ABORT,'revision refusal'); END`;
        }),
      );
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const revision = yield* writer.revision;
          assert.strictEqual(
            (yield* Effect.flip(writer.saveAcceptance(acceptance, revision)))._tag,
            "LibrarySqlError",
          );
          assert.strictEqual(yield* writer.revision, revision);
        }),
      );
      assert.strictEqual(
        libraryStateRevision(yield* loadLibrary(home)),
        libraryStateRevision(state),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a first native acceptance retains empty-list presence through document compatibility writes",
  () =>
    Effect.gen(function* () {
      const { home, state, acceptance } = yield* prepared;
      yield* writeLibrary(
        home,
        Effect.gen(function* () {
          const writer = yield* LibraryWriter;
          const { assessmentAcceptances: _old, ...without } = state;
          yield* writer.save(without, state);
          assert.isFalse(Object.hasOwn(yield* loadLibrary(home), "assessmentAcceptances"));
          yield* writer.saveAcceptance(acceptance, yield* writer.revision);
          const added = yield* loadLibrary(home);
          assert.deepStrictEqual(added.assessmentAcceptances, [acceptance]);
          const empty = { ...added, assessmentAcceptances: [] };
          yield* writer.save(empty, added);
          const saved = yield* loadLibrary(home);
          assert.isTrue(Object.hasOwn(saved, "assessmentAcceptances"));
          assert.deepStrictEqual(saved.assessmentAcceptances, []);
          assert.strictEqual(libraryStateRevision(saved), libraryStateRevision(empty));
        }),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("an audit failure rolls back the acceptance, presence marker and native revision", () =>
  Effect.gen(function* () {
    const { home, path, acceptance } = yield* prepared;
    const before = yield* loadLibrary(home),
      history = yield* readLibraryAudit(home);
    yield* withLibraryDatabase(
      path,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER refuse_acceptance_audit BEFORE INSERT ON library_audit_events BEGIN SELECT RAISE(ABORT,'audit refusal'); END`;
      }),
    );
    yield* writeLibrary(
      home,
      Effect.gen(function* () {
        const writer = yield* LibraryWriter;
        const revision = yield* writer.revision;
        assert.strictEqual(
          (yield* Effect.flip(writer.saveAcceptance(acceptance, revision)))._tag,
          "LibrarySqlError",
        );
        assert.strictEqual(yield* writer.revision, revision);
      }),
    );
    assert.deepStrictEqual(yield* loadLibrary(home), before);
    assert.deepStrictEqual(yield* readLibraryAudit(home), history);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
