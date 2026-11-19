import { expectTypeOf, test } from "vitest";
import type { AuthorHistoryShape } from "../src/author/history.js";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { join } from "node:path";
import { backupAuthorHistory, backupAuthorWorkspace } from "../src/author/backup.js";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace, WorkspaceId, type WorkspaceLease } from "../src/author/workspace.js";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import { SqlClient } from "effect/sql";
import { libraryDatabasePath, withLibraryDatabase } from "../src/library/store/database.js";
import { prepareAuthorState } from "../src/author/state-store.js";
import { skitLayer } from "../src/platform/layer.js";

const ownerLayer = (home: string) =>
  AuthorHistory.layer({ home }).pipe(Layer.provideMerge(AuthorWorkspace.layer));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-backup-" });
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  yield* fs.makeDirectory(workspace);
  yield* fs.writeFileString(join(workspace, "notes.txt"), "A");
  return { fs, home, workspace, bindings: join(home, "author-sync.json") };
});
const register = Effect.fn("Test.registerBackupWorkspace")(function* (lease: WorkspaceLease) {
  const identity = yield* (yield* AuthorWorkspace).readIdentity(lease.root);
  if (Option.isSome(identity))
    return yield* Effect.die("Expected an unidentified fixture workspace");
  return yield* lease.register(Option.none());
});
const locator = "skit://registry.example/swyx/tools";

it.effect(
  "backup reads preserve absent storage and independent documents without acknowledgements",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const key = { workspaceId: WorkspaceId.make(`workspace_${"a".repeat(32)}`), locator };
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        expect(yield* history.backupState.read(key)).toBeNull();
        expect(yield* f.fs.exists(f.home)).toBe(false);
        const old = '{"schema":"skit.author-sync.v1","workspaces":{}}\n';
        yield* f.fs.makeDirectory(f.home);
        yield* f.fs.writeFileString(f.bindings, old);
        expect(yield* history.backupState.read(key)).toBeNull();
        expect(yield* f.fs.readFileString(f.bindings)).toBe(old);
      }).pipe(Effect.provide(ownerLayer(f.home)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("backup checkpoints advance contiguous A-B-A observations and preserve sync state", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const acknowledged = yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.workspace);
      const lease = yield* workspaces.acquire(root);
      const { workspaceId } = yield* register(lease);
      const key = { workspaceId, locator };
      const a = yield* history.refresh(root);
      yield* f.fs.writeFileString(join(root, "notes.txt"), "B");
      const b = yield* history.refresh(root);
      yield* f.fs.writeFileString(join(root, "notes.txt"), "A");
      const again = yield* history.refresh(root);
      const sending = Sync.Sending.make({ base: null, revision: a.id });
      yield* history.syncState.save(lease, key, {
        from: Sync.Idle.make({ base: null }),
        to: sending,
      });
      const before = yield* history.syncState.read(key);
      expect(
        yield* Effect.flip(history.backupState.save(lease, key, { from: null, to: b.id })),
      ).toMatchObject({
        _tag: "AuthorHistoryInvalid",
        reason: { _tag: "BackupParentMismatch", expected: null, actual: [a.id] },
      });
      expect(yield* history.syncState.read(key)).toEqual(before);
      yield* history.backupState.save(lease, key, { from: null, to: a.id });
      yield* history.backupState.save(lease, key, { from: a.id, to: b.id });
      yield* history.backupState.save(lease, key, { from: b.id, to: again.id });
      expect(again.id).not.toBe(a.id);
      expect(again.treeHash).toBe(a.treeHash);
      expect(yield* history.syncState.read(key)).toEqual(sending);
      const saved = yield* history.syncState.read(key);
      const revision = yield* lease.revision;
      yield* history.backupState.save(lease, key, { from: again.id, to: again.id });
      expect(yield* lease.revision).toBe(revision);
      expect(yield* history.syncState.read(key)).toEqual(saved);
      expect(
        yield* Effect.flip(history.backupState.save(lease, key, { from: a.id, to: b.id })),
      ).toMatchObject({ _tag: "AuthorBackupStateConflict", found: again.id });
      return { key, id: again.id, lease };
    }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
    // A separate owner/runtime sees the durable acknowledgement, but a closed lease cannot save.
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      expect(yield* history.backupState.read(acknowledged.key)).toBe(acknowledged.id);
      expect(
        yield* Effect.exit(
          history.backupState.save(acknowledged.lease, acknowledged.key, {
            from: acknowledged.id,
            to: acknowledged.id,
          }),
        ),
      ).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              _tag: "Die",
              defect: {
                _tag: "AuthorWorkspaceInvariantFailed",
                reason: { _tag: "LeaseClosed" },
              },
            },
          ],
        },
      });
    }).pipe(Effect.provide(ownerLayer(f.home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("first-connection reset clears only its backup checkpoint", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.workspace);
      const lease = yield* workspaces.acquire(root);
      const { workspaceId } = yield* register(lease);
      const first = { workspaceId, locator };
      const otherRemote = { workspaceId, locator: "skit://registry.example/swyx/other" };
      const otherWorkspace = {
        workspaceId: WorkspaceId.make(`workspace_${"b".repeat(32)}`),
        locator,
      };
      const observation = yield* history.refresh(root);
      for (const key of [first, otherRemote, otherWorkspace])
        yield* history.backupState.save(lease, key, { from: null, to: observation.id });
      yield* history.syncState.save(lease, first, {
        from: Sync.Idle.make({ base: null }),
        reset: {
          requestId: "new-connection",
          remote: {
            schema: "skit.remote.v1",
            origin: "https://registry.example",
            namespace: "swyx",
            skit: "tools",
          },
        },
      });
      expect(yield* history.backupState.read(first)).toBeNull();
      expect(yield* history.backupState.read(otherRemote)).toBe(observation.id);
      expect(yield* history.backupState.read(otherWorkspace)).toBe(observation.id);
    }).pipe(Effect.provide(ownerLayer(f.home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const boundary of ["before-commit", "after-commit"] as const)
  it.effect(`backup acknowledgement survives restart ${boundary}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const recorded = yield* Effect.gen(function* () {
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(f.workspace);
        const lease = yield* workspaces.acquire(root);
        const { workspaceId } = yield* register(lease);
        const observation = yield* (yield* AuthorHistory).refresh(root);
        return { key: { workspaceId, locator }, id: observation.id };
      }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
      yield* prepareAuthorState(f.home, { create: true });
      if (boundary === "before-commit")
        yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER refuse_author_backup BEFORE INSERT ON author_backup_checkpoints BEGIN SELECT RAISE(ABORT, 'fixture refuses acknowledgement'); END`;
          }),
        );
      let stopped = false;
      const result = yield* Effect.gen(function* () {
        const workspaces = yield* AuthorWorkspace;
        const lease = yield* workspaces.acquire(yield* workspaces.resolveRoot(f.workspace));
        const interrupted: WorkspaceLease =
          boundary === "after-commit"
            ? {
                ...lease,
                advance: Effect.sync(() => {
                  stopped = true;
                }).pipe(Effect.andThen(Effect.die(new Error("fixture stops after commit")))),
              }
            : lease;
        yield* (yield* AuthorHistory).backupState.save(interrupted, recorded.key, {
          from: null,
          to: recorded.id,
        });
      }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped, Effect.exit);
      expect(result._tag).toBe("Failure");
      if (boundary === "after-commit") expect(stopped).toBe(true);
      if (boundary === "before-commit")
        yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            yield* (yield* SqlClient.SqlClient)`DROP TRIGGER refuse_author_backup`;
          }),
        );
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const found = yield* history.backupState.read(recorded.key);
        expect(found).toBe(boundary === "before-commit" ? null : recorded.id);
        const lease = yield* (yield* AuthorWorkspace).acquire(
          yield* (yield* AuthorWorkspace).resolveRoot(f.workspace),
        );
        yield* history.backupState.save(lease, recorded.key, { from: found, to: recorded.id });
        expect(yield* history.backupState.read(recorded.key)).toBe(recorded.id);
      }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect(
  "a prepared write saves its captured next state and stale checkpoints still conflict",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(f.workspace);
        const lease = yield* workspaces.acquire(root);
        const { workspaceId } = yield* register(lease);
        const key = { workspaceId, locator };
        const observation = yield* history.refresh(root);
        const idle = Sync.Idle.make({ base: null });
        const sending = Sync.Sending.make({ base: null, revision: observation.id });
        yield* history.syncState.save(lease, key, { from: idle, to: sending });
        const writing = Sync.Writing.make({
          base: null,
          from: observation.treeHash,
          to: observation.treeHash,
          next: sending,
          merged: false,
        });
        const prepared = yield* history.syncState.prepareWrite(lease, key, {
          from: sending,
          to: writing,
        });
        expect(yield* history.syncState.read(key)).toEqual(writing);
        const checkpoint = yield* history.syncState.read(key);
        expect(
          yield* Effect.flip(history.syncState.save(lease, key, { from: idle, to: sending })),
        ).toMatchObject({ _tag: "AuthorSyncStateConflict", found: writing });
        expect(yield* history.syncState.read(key)).toEqual(checkpoint);
        const resumed = yield* history.syncState.prepareWrite(lease, key, {
          from: writing,
          trees: { from: observation.treeHash, to: observation.treeHash },
        });
        expect(yield* history.syncState.read(key)).toEqual({ ...writing, merged: true });
        // Mutating the caller's request after preparation cannot redirect completion.
        Reflect.set(writing, "next", Sync.Idle.make({ base: observation.id }));
        expect(yield* resumed.apply()).toEqual(sending);
        expect(yield* history.syncState.read(key)).toEqual(sending);
        expect(yield* f.fs.readFileString(join(root, "notes.txt"))).toBe("A");
        // An operation from before recovery cannot apply after recovery saved another checkpoint.
        expect(yield* Effect.exit(prepared.apply())).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ _tag: "Die" }] },
        });
      }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

test("sync checkpoint types exclude null-base completion and caller-selected recovery states", () => {
  type Change = Parameters<AuthorHistoryShape["syncState"]["save"]>[2];
  type Normal = Extract<Change, { readonly to: unknown }>;
  expectTypeOf<Extract<Normal["from"], typeof Sync.Writing.Type>>().toBeNever();
  expectTypeOf<{ readonly _tag: "Idle"; readonly base: null }>().not.toExtend<Normal["to"]>();
  type Resume = Extract<Sync.WriteRequest, { readonly trees: unknown }>;
  expectTypeOf<Resume>().toEqualTypeOf<{
    readonly from: typeof Sync.Writing.Type;
    readonly trees: {
      readonly from: (typeof Sync.Writing.Type)["from"];
      readonly to: (typeof Sync.Writing.Type)["to"];
    };
    readonly mergedRevision?: (typeof Sync.Sending.Type)["revision"];
  }>();
});

it.effect("backup refuses BackupDisconnected without uploading or saving an acknowledgement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const posts: string[] = [];
    yield* Effect.gen(function* () {
      expect(
        yield* Effect.flip(
          backupAuthorWorkspace(f.workspace, {
            post: (id) =>
              Effect.sync(() => {
                posts.push(id);
              }),
          }),
        ),
      ).toMatchObject({
        _tag: "AuthorHistoryInvalid",
        reason: { _tag: "BackupDisconnected" },
      });
      expect(posts).toEqual([]);
      expect(yield* f.fs.exists(f.bindings)).toBe(false);
      expect(yield* f.fs.readFileString(join(f.workspace, "notes.txt"))).toBe("A");
    }).pipe(Effect.provide(ownerLayer(f.home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("backup refuses BackupNotAncestor before posting an older observation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.workspace);
      const lease = yield* workspaces.acquire(root);
      const { workspaceId } = yield* register(lease);
      const key = { workspaceId, locator };
      const first = yield* history.refresh(root);
      yield* f.fs.writeFileString(join(root, "notes.txt"), "B");
      const second = yield* history.refresh(root);
      yield* history.backupState.save(lease, key, { from: null, to: first.id });
      yield* history.backupState.save(lease, key, { from: first.id, to: second.id });
      const before = yield* history.syncState.read(key);
      const posts: string[] = [];
      expect(
        yield* Effect.flip(
          backupAuthorHistory(lease, key, first, {
            post: (id) =>
              Effect.sync(() => {
                posts.push(id);
              }),
          }),
        ),
      ).toMatchObject({
        _tag: "AuthorHistoryInvalid",
        reason: { _tag: "BackupNotAncestor", acknowledged: second.id, observation: first.id },
      });
      expect(posts).toEqual([]);
      expect(yield* history.syncState.read(key)).toEqual(before);
      expect(yield* history.backupState.read(key)).toBe(second.id);
      expect(yield* f.fs.readFileString(join(root, "notes.txt"))).toBe("B");
    }).pipe(Effect.provide(ownerLayer(f.home)));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// This is a completion fast path, not crash recovery: interruption before it may upload
// one redundant revision through refresh. Head and ACK must never be partially advanced.
for (const mismatch of [
  "none",
  "bytes",
  "mode",
  "directory",
  "head",
  "ack",
  "state",
  "sql",
] as const)
  it.effect(`pure-pull completion: ${mismatch}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(f.workspace);
        const lease = yield* workspaces.acquire(root);
        const { workspaceId } = yield* register(lease);
        const key = { workspaceId, locator };
        const before = yield* history.refresh(root);
        if (mismatch !== "ack")
          yield* history.backupState.save(lease, key, { from: null, to: before.id });
        const oldTree = yield* history.engineStore.tree(before.treeHash);
        const tree = oldTree.map((entry) =>
          entry.kind === "file" ? { ...entry, bytes: new TextEncoder().encode("received") } : entry,
        );
        const received = yield* History.record(history.engineStore, tree, [before.id], {
          ...before.revision.author,
          at: before.revision.author.at + 1000,
        });
        yield* history.syncState.save(lease, key, {
          from: Sync.Idle.make({ base: null }),
          to: { _tag: "Idle", base: mismatch === "state" ? before.id : received.id },
        });
        yield* f.fs.writeFileString(
          join(root, "notes.txt"),
          mismatch === "bytes" ? "different" : "received",
        );
        if (mismatch === "mode") yield* f.fs.chmod(join(root, "notes.txt"), 0o755);
        if (mismatch === "directory") yield* f.fs.makeDirectory(join(root, "empty"));
        const latest = mismatch === "head" ? yield* history.refresh(root) : before;
        const ack = yield* history.backupState.read(key);
        const state = yield* history.syncState.read(key);
        const leaseRevision = yield* lease.revision;
        if (mismatch === "sql")
          yield* withLibraryDatabase(
            libraryDatabasePath(f.home),
            Effect.gen(function* () {
              yield* (yield* SqlClient.SqlClient)`CREATE TRIGGER refuse_received_ack BEFORE UPDATE ON author_backup_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END`;
            }),
          );
        const result = yield* Effect.result(
          history.saveReceived(lease, key, {
            before: before.id,
            received: received.id,
          }),
        );
        if (mismatch === "sql") {
          expect(result._tag).toBe("Failure");
          yield* withLibraryDatabase(
            libraryDatabasePath(f.home),
            Effect.gen(function* () {
              yield* (yield* SqlClient.SqlClient)`DROP TRIGGER refuse_received_ack`;
            }),
          );
        } else expect(result).toMatchObject({ _tag: "Success", success: mismatch === "none" });
        expect(yield* history.syncState.read(key)).toEqual(state);
        expect(yield* history.backupState.read(key)).toBe(mismatch === "none" ? received.id : ack);
        expect(yield* lease.revision).toBe(leaseRevision + (mismatch === "none" ? 1 : 0));
        const rows = yield* withLibraryDatabase(
          libraryDatabasePath(f.home),
          Effect.gen(function* () {
            return yield* (yield* SqlClient.SqlClient)<{
              revision: string;
            }>`SELECT revision FROM author_history_events ORDER BY sequence DESC LIMIT 1`;
          }),
          true,
        );
        expect(rows[0]?.revision).toBe(mismatch === "none" ? received.id : latest.id);
        // Immutable prior history is still available even after the head moves to the remote.
        expect(yield* history.engineStore.revision(before.id)).toEqual(before.revision);
        if (mismatch !== "none") return;
        const completed = yield* history.refresh(root, received.id);
        expect(completed.id).toBe(received.id);
        const posts: string[] = [];
        const remote = {
          post: (id: History.RevisionId) =>
            Effect.sync(() => {
              posts.push(id);
            }),
        };
        yield* backupAuthorHistory(lease, key, completed, remote);
        expect(posts).toEqual([]);
        yield* f.fs.writeFileString(join(root, "notes.txt"), "B's later edit");
        const next = yield* history.refresh(root);
        expect(next.revision.parents).toEqual([received.id]);
        yield* backupAuthorHistory(lease, key, next, remote);
        expect(posts).toEqual([next.id]);
      }).pipe(Effect.provide(ownerLayer(f.home)));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

it.effect("a crash before pure-pull completion keeps the ordinary redundant-backup path", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pulled = yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.workspace);
      const lease = yield* workspaces.acquire(root);
      const { workspaceId } = yield* register(lease);
      const key = { workspaceId, locator };
      const before = yield* history.refresh(root);
      yield* history.backupState.save(lease, key, { from: null, to: before.id });
      const tree = (yield* history.engineStore.tree(before.treeHash)).map((entry) =>
        entry.kind === "file" ? { ...entry, bytes: new TextEncoder().encode("received") } : entry,
      );
      const received = yield* History.record(history.engineStore, tree, [before.id], {
        ...before.revision.author,
        at: before.revision.author.at + 1000,
      });
      yield* f.fs.writeFileString(join(root, "notes.txt"), "received");
      yield* history.syncState.save(lease, key, {
        from: Sync.Idle.make({ base: null }),
        to: { _tag: "Idle", base: received.id },
      });
      // The write/checkpoint committed, but the process stopped before saveReceived.
      return { key, received };
    }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const workspaces = yield* AuthorWorkspace;
      const root = yield* workspaces.resolveRoot(f.workspace);
      const lease = yield* workspaces.acquire(root);
      const completed = yield* history.refresh(root, pulled.received.id);
      expect(completed.id).not.toBe(pulled.received.id);
      expect(completed.treeHash).toBe(pulled.received.revision.tree);
      const posts: string[] = [];
      yield* backupAuthorHistory(lease, pulled.key, completed, {
        post: (id) =>
          Effect.sync(() => {
            posts.push(id);
          }),
      });
      expect(posts).toEqual([completed.id]);
      expect(yield* history.backupState.read(pulled.key)).toBe(completed.id);
      expect(yield* f.fs.readFileString(join(root, "notes.txt"))).toBe("received");
    }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
