import { WorkspaceFailure } from "../src/author/workspace-contracts.js";
import { AuthorWorkspace, type WorkspaceLease } from "../src/author/workspace.js";
import { AuthorHistory } from "../src/author/history.js";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Scope, Schema } from "effect";
import { join } from "node:path";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import { scanAuthorSyncTree } from "../src/author/index.js";

import { authorLayer } from "./helpers/author-history.js";
import { testPlatformLayer } from "./helpers/platform.js";

const remote = {
  schema: "skit.remote.v1",
  origin: "https://registry.example",
  namespace: "swyx",
  skit: "tools",
} as const;

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaces = yield* AuthorWorkspace;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-workspace-" });
  yield* fs.writeFileString(join(folder, "notes.txt"), "before\n");
  const root = yield* workspaces.resolveRoot(folder);
  return { fs, workspaces, root };
});

it.effect("a read never creates .skit or the lock", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.workspaces.read(f.root)).toEqual({
      root: f.root,
      identity: Option.none(),
      connection: { _tag: "Unconnected" },
    });
    expect(yield* f.fs.readDirectory(f.root)).toEqual(["notes.txt"]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("resolveRoot refuses anything but an existing directory", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    for (const input of [join(f.root, "missing"), join(f.root, "notes.txt")])
      expect(yield* Effect.flip(f.workspaces.resolveRoot(input))).toMatchObject({
        _tag: "AuthorWorkspaceRootInvalid",
        input,
      });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("the lease is exclusive, even in one process, until its scope closes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const scope = yield* Scope.make();
    yield* f.workspaces.acquire(f.root).pipe(Scope.provide(scope));
    expect(yield* f.fs.readFileString(join(f.root, ".skit/.gitignore"))).toBe("*\n");
    expect(yield* Effect.flip(Effect.scoped(f.workspaces.acquire(f.root)))).toMatchObject({
      _tag: "AuthorWorkspaceBusy",
      root: f.root,
    });
    yield* Scope.close(scope, Exit.void);
    yield* Effect.scoped(f.workspaces.acquire(f.root));
    // The lock file holds no data and is never unlinked.
    expect(yield* f.fs.exists(join(f.root, ".skit/lock.sqlite"))).toBe(true);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("acquire refuses a .skit or a lock that is not what it claims to be", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const elsewhere = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-elsewhere-" });
    yield* f.fs.symlink(elsewhere, join(f.root, ".skit"));
    expect(yield* Effect.flip(Effect.scoped(f.workspaces.acquire(f.root)))).toMatchObject({
      _tag: "AuthorWorkspaceUnsafe",
      path: join(f.root, ".skit"),
    });
    yield* f.fs.remove(join(f.root, ".skit"));
    yield* f.fs.makeDirectory(join(f.root, ".skit"));
    yield* f.fs.symlink(join(elsewhere, "lock"), join(f.root, ".skit/lock.sqlite"));
    expect(yield* Effect.flip(Effect.scoped(f.workspaces.acquire(f.root)))).toMatchObject({
      _tag: "AuthorWorkspaceUnsafe",
      path: join(f.root, ".skit/lock.sqlite"),
    });
    expect(yield* f.fs.readDirectory(elsewhere)).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("acquire removes the stage folders an interrupted write left", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.makeDirectory(join(f.root, ".skit/stage-left/skills"), { recursive: true });
    yield* f.fs.writeFileString(join(f.root, ".skit/stage-left/skills/SKILL.md"), "partial");
    yield* Effect.scoped(f.workspaces.acquire(f.root));
    expect((yield* f.fs.readDirectory(join(f.root, ".skit"))).sort()).toEqual([
      ".gitignore",
      "lock.sqlite",
    ]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a lease handle used after its scope closed is refused", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const lease = yield* Effect.scoped(f.workspaces.acquire(f.root));
    expect(yield* Effect.exit(lease.advance)).toMatchObject({
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
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("closing a lease waits for its in-flight identity write", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const order: string[] = [];
    yield* Effect.gen(function* () {
      const workspaces = yield* AuthorWorkspace;
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const lease = yield* workspaces.acquire(f.root).pipe(Scope.provide(scope));
      const writing = yield* lease.register(Option.none()).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            order.push("closed");
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(writing);
      yield* Fiber.join(closing);
    }).pipe(
      Effect.provide(Layer.fresh(AuthorWorkspace.layer)),
      Effect.provideService(FileSystem.FileSystem, {
        ...f.fs,
        link: (from, to) =>
          Effect.gen(function* () {
            if (to === join(f.root, ".skit/workspace.json")) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            yield* f.fs.link(from, to);
            if (to === join(f.root, ".skit/workspace.json")) order.push("published");
          }),
      }),
    );
    expect(order).toEqual(["published", "closed"]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("the first connection: checkpoint, a receipt that must match, then the remote", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const lease = yield* f.workspaces.acquire(f.root);
    const connecting = yield* lease.transition({
      from: { _tag: "Unconnected" },
      to: { _tag: "Connecting", remote, visibility: "private" },
    });
    if (connecting._tag !== "Connecting") return yield* Effect.die("expected Connecting");
    expect(connecting.requestId).not.toBe("");
    expect((yield* f.workspaces.read(f.root)).connection).toEqual(connecting);
    // Only this checkpoint's own request may connect it.
    expect(
      yield* Effect.flip(
        lease.transition({
          from: connecting,
          to: { _tag: "Connected" },
          receipt: { requestId: "another request", remote },
        }),
      ),
    ).toMatchObject({ _tag: "AuthorWorkspaceConflict" });
    expect(
      yield* lease.transition({
        from: connecting,
        to: { _tag: "Connected" },
        receipt: { requestId: connecting.requestId, remote },
      }),
    ).toEqual({ _tag: "Connected", remote, leftover: { _tag: "None" } });
    expect(JSON.parse(yield* f.fs.readFileString(join(f.root, "skit.remote.json")))).toEqual(
      remote,
    );
    expect(yield* f.fs.exists(join(f.root, ".skit/connection.json"))).toBe(false);
    // Planning from a state no longer there is a conflict, never a lost write.
    expect(
      yield* Effect.flip(lease.transition({ from: connecting, to: { _tag: "Unconnected" } })),
    ).toMatchObject({ _tag: "AuthorWorkspaceConflict" });
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a checkpoint left beside the remote is reported, and only a matching one goes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const checkpoint = join(f.root, ".skit/connection.json");
    yield* f.fs.makeDirectory(join(f.root, ".skit"));
    yield* f.fs.writeFileString(join(f.root, "skit.remote.json"), JSON.stringify(remote));
    const leftover = (connection: unknown) =>
      f.fs.writeFileString(checkpoint, JSON.stringify(connection)).pipe(
        Effect.andThen(f.workspaces.read(f.root)),
        Effect.map(({ connection }) =>
          connection._tag === "Connected" ? connection.leftover._tag : connection._tag,
        ),
      );
    const pending = { _tag: "Connecting", remote, visibility: "private", requestId: "request" };
    expect(yield* leftover({ ...pending, remote: { ...remote, skit: "other" } })).toBe(
      "Mismatched",
    );
    expect(yield* leftover({ broken: true })).toBe("Invalid");
    expect(yield* leftover(pending)).toBe("Matching");
    const lease = yield* f.workspaces.acquire(f.root);
    const { connection } = yield* f.workspaces.read(f.root);
    if (connection._tag !== "Connected" || connection.leftover._tag !== "Matching")
      return yield* Effect.die("expected a matching leftover");
    yield* lease.transition({
      from: { ...connection, leftover: connection.leftover },
      to: { _tag: "Connected" },
    });
    expect(yield* f.fs.exists(checkpoint)).toBe(false);
    expect(yield* f.fs.exists(join(f.root, "skit.remote.json"))).toBe(true);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

/** The workspace's one file, then that file rewritten. */
const trees = (root: string) =>
  Effect.gen(function* () {
    const from = (yield* scanAuthorSyncTree(root)).tree;
    const to = from.map((entry) =>
      entry.kind === "file" ? { ...entry, bytes: new TextEncoder().encode("after\n") } : entry,
    );
    return {
      from,
      to,
      fromHash: yield* History.treeHash(from),
      toHash: yield* History.treeHash(to),
    };
  });

const identified = (lease: WorkspaceLease) => lease.register(Option.none());

it.effect("preparation returns a write bound to its lease and private saved trees", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const home = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-author-home-" });
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const lease = yield* f.workspaces.acquire(f.root);
      const { workspaceId } = yield* identified(lease);
      const key = { workspaceId, locator: "skit://registry.example/swyx/tools" };
      const { from, to, fromHash, toHash } = yield* trees(f.root);
      yield* history.saveTree(from);
      yield* history.saveTree(to);
      const idle = Sync.Idle.make({ base: null });
      const writing = Sync.Writing.make({
        base: null,
        from: fromHash,
        to: toHash,
        next: Sync.Sending.make({ base: null, revision: History.RevisionId.make(toHash) }),
        merged: false,
      });
      const stale = yield* history.syncState.prepareWrite(lease, key, { from: idle, to: writing });
      yield* lease.advance;
      expect(yield* Effect.exit(stale.apply())).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              _tag: "Die",
              defect: {
                _tag: "AuthorWorkspaceInvariantFailed",
                reason: { _tag: "CheckpointChanged" },
              },
            },
          ],
        },
      });
      const other = yield* otherLease;
      const foreignKey = { ...key, workspaceId: (yield* identified(other)).workspaceId };
      const checkpoint = yield* f.fs.readFileString(join(home, "author-sync.json"));
      expect(
        yield* Effect.flip(
          history.syncState.prepareWrite(lease, foreignKey, {
            from: idle,
            to: writing,
          }),
        ),
      ).toMatchObject({ _tag: "AuthorWorkspaceConflict" });
      expect(yield* f.fs.readFileString(join(home, "author-sync.json"))).toBe(checkpoint);
      const current = yield* history.syncState.prepareWrite(lease, key, {
        from: writing,
        trees: { from: fromHash, to: toHash },
      });
      // Neither caller-owned tree data nor another lease can redirect the bound write.
      for (const tree of [from, to])
        for (const entry of tree) if (entry.kind === "file") entry.bytes.fill(33);
      const attempts = yield* Effect.all(
        [Effect.exit(current.apply()), Effect.exit(current.apply())],
        { concurrency: "unbounded" },
      );
      expect(attempts.map((exit) => exit._tag).sort()).toEqual(["Failure", "Success"]);
      expect(yield* history.syncState.read(key)).toEqual(writing.next);
      expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("after\n");
      expect(yield* f.fs.exists(join(other.root, "notes.txt"))).toBe(false);
      expect(
        (yield* f.fs.readDirectory(join(f.root, ".skit"))).filter((name) =>
          name.startsWith("stage-"),
        ),
      ).toEqual([]);
      expect(attempts.find((exit) => exit._tag === "Failure")).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [
            {
              _tag: "Die",
              defect: {
                _tag: "AuthorWorkspaceInvariantFailed",
                reason: { _tag: "WriteAlreadyUsed" },
              },
            },
          ],
        },
      });
    }).pipe(Effect.provide(authorLayer(home)));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a prepared operation cannot write after its lease scope closes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const home = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-closed-write-" });
    const prepared = yield* Effect.scoped(
      Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const lease = yield* f.workspaces.acquire(f.root);
        const { workspaceId } = yield* identified(lease);
        const { from, to, fromHash, toHash } = yield* trees(f.root);
        yield* history.saveTree(from);
        yield* history.saveTree(to);
        return yield* history.syncState.prepareWrite(
          lease,
          { workspaceId, locator: "skit://registry.example/swyx/tools" },
          {
            from: Sync.Idle.make({ base: null }),
            to: Sync.Writing.make({
              base: null,
              from: fromHash,
              to: toHash,
              next: Sync.Sending.make({ base: null, revision: History.RevisionId.make(toHash) }),
              merged: false,
            }),
          },
        );
      }).pipe(Effect.provide(authorLayer(home))),
    );
    expect(yield* Effect.exit(prepared.apply())).toMatchObject({
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
    expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("before\n");
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["missing", "changed", "malformed", "edited"] as const)(
  "a prepared write reports %s workspace data as a recoverable failure without writing",
  (damage) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const home = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-changed-write-" });
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const lease = yield* f.workspaces.acquire(f.root);
        const { workspaceId } = yield* identified(lease);
        const key = { workspaceId, locator: "skit://registry.example/swyx/tools" };
        const { from, to, fromHash, toHash } = yield* trees(f.root);
        yield* history.saveTree(from);
        yield* history.saveTree(to);
        const prepared = yield* history.syncState.prepareWrite(lease, key, {
          from: Sync.Idle.make({ base: null }),
          to: Sync.Writing.make({
            base: null,
            from: fromHash,
            to: toHash,
            next: Sync.Sending.make({ base: null, revision: History.RevisionId.make(toHash) }),
            merged: false,
          }),
        });
        const identity = join(f.root, ".skit/workspace.json");
        if (damage === "missing") yield* f.fs.remove(identity);
        if (damage === "changed")
          yield* f.fs.writeFileString(
            identity,
            JSON.stringify({
              schema: "skit.author-workspace.v1",
              workspace_id: `workspace_${"a".repeat(32)}`,
            }),
          );
        if (damage === "malformed") yield* f.fs.writeFileString(identity, "broken identity");
        if (damage === "edited")
          yield* f.fs.writeFileString(join(f.root, "notes.txt"), "external edit\n");
        const failure = yield* Effect.flip(prepared.apply());
        expect(failure._tag).toBe(
          damage === "malformed"
            ? "AuthorWorkspaceMetadataInvalid"
            : damage === "edited"
              ? "LocalFilesChangedDuringSync"
              : "AuthorWorkspaceConflict",
        );
        expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe(
          damage === "edited" ? "external edit\n" : "before\n",
        );
      }).pipe(Effect.provide(authorLayer(home)));
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

/** A lease on a second, empty workspace. */
const otherLease = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaces = yield* AuthorWorkspace;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-other-" });
  return yield* workspaces.acquire(yield* workspaces.resolveRoot(folder));
});

it.effect("prepareWrite refuses an impossible namespace without saving a checkpoint", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const home = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-invalid-write-" });
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const lease = yield* f.workspaces.acquire(f.root);
      const { workspaceId } = yield* identified(lease);
      const { from } = yield* trees(f.root);
      const to: History.Tree = [
        { path: "notes", kind: "file", mode: 0o644, bytes: new TextEncoder().encode("parent") },
        {
          path: "notes/a.txt",
          kind: "file",
          mode: 0o644,
          bytes: new TextEncoder().encode("child"),
        },
      ];
      const fromHash = yield* history.saveTree(from);
      const toHash = yield* history.saveTree(to);
      const key = { workspaceId, locator: "skit://registry.example/swyx/tools" };
      const writing = Sync.Writing.make({
        base: null,
        from: fromHash,
        to: toHash,
        next: Sync.Sending.make({ base: null, revision: History.RevisionId.make(toHash) }),
        merged: false,
      });
      expect(
        yield* Effect.flip(
          history.syncState.prepareWrite(lease, key, {
            from: Sync.Idle.make({ base: null }),
            to: writing,
          }),
        ),
      ).toMatchObject({
        _tag: "AuthorHistoryInvalid",
        reason: { _tag: "InvalidTree", issue: { _tag: "ParentNotDirectory" } },
      });
      expect(yield* f.fs.exists(join(home, "author-sync.json"))).toBe(false);
      expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("before\n");
    }).pipe(Effect.provide(authorLayer(home)));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("a malformed checkpoint retains schema paths and cannot be changed by a read", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const file = join(f.root, ".skit/connection.json");
    yield* f.fs.makeDirectory(join(f.root, ".skit"));
    const text = JSON.stringify({
      _tag: "Connecting",
      remote,
      visibility: "private",
      requestId: 42,
    });
    yield* f.fs.writeFileString(file, text);
    const failure = yield* f.workspaces.read(f.root).pipe(Effect.flip);
    expect(failure).toMatchObject({
      _tag: "AuthorSyncStateInvalid",
      path: file,
      reason: {
        _tag: "InvalidData",
        failure: expect.objectContaining({ _tag: "SchemaError" }),
      },
    });
    const wire = Schema.encodeUnknownSync(WorkspaceFailure)(failure);
    const decoded = Schema.decodeUnknownSync(WorkspaceFailure)(JSON.parse(JSON.stringify(wire)));
    expect(decoded).toMatchObject({ _tag: "AuthorSyncStateInvalid", code: "OPERATION_FAILED" });
    expect(wire).not.toHaveProperty("message");
    expect(yield* f.fs.readFileString(file)).toBe(text);
  }).pipe(Effect.provide(testPlatformLayer)),
);
