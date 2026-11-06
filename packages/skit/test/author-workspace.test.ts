import { AuthorWorkspace, type WorkspaceLease } from "../src/author/workspace.js";
import { AuthorHistory } from "../src/author/history.js";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Option, Scope } from "effect";
import { join } from "node:path";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import { type Identity, scanAuthorSyncTree } from "../src/author/index.js";

import { authorLayer } from "./helpers/author-history.js";
import { testPlatformLayer } from "./helpers/platform.js";

const remote = {
  schema: "skit.remote.v1",
  origin: "https://registry.example",
  namespace: "swyx",
  skit: "tools",
} as const;
const absent = Option.none<Identity>();

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
    expect(yield* Effect.flip(lease.advance)).toMatchObject({ _tag: "AuthorLeaseNotHeld" });
  }).pipe(Effect.provide(testPlatformLayer)),
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

const identified = (lease: WorkspaceLease) =>
  Option.isSome(absent)
    ? Effect.die("absent is None")
    : lease.register({ from: absent, to: "IdentityOnly", adopt: Option.none() });

it.effect("writeTree writes only with a current, unused PreparedWrite for exactly its trees", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const home = yield* f.fs.makeTempDirectoryScoped({ prefix: "skit-author-home-" });
    yield* Effect.gen(function* () {
      const history = yield* AuthorHistory;
      const lease = yield* f.workspaces.acquire(f.root);
      const { workspaceId } = yield* identified(lease);
      const key = { workspaceId, locator: "skit://registry.example/swyx/tools" };
      const { from, to, fromHash, toHash } = yield* trees(f.root);
      yield* history.retain(from);
      yield* history.retain(to);
      const idle = Sync.Idle.make({ base: null });
      const writing = Sync.Writing.make({
        base: null,
        from: fromHash,
        to: toHash,
        next: Sync.Sending.make({ base: null, revision: History.RevisionId.make(toHash) }),
        merged: false,
      });
      const notPrepared = { _tag: "AuthorWriteNotPrepared" };

      // A later checkpoint step makes an outstanding PreparedWrite stale.
      const stale = yield* history.syncState.prepareWrite(lease, key, { from: idle, to: writing });
      yield* lease.advance;
      expect(yield* Effect.flip(lease.writeTree({ prepared: stale, from, to }))).toMatchObject(
        notPrepared,
      );

      // One for other trees is refused, and the attempt uses it up.
      const prepared = yield* history.syncState.prepareWrite(lease, key, {
        from: writing,
        to: writing,
      });
      expect(yield* Effect.flip(lease.writeTree({ prepared, from, to: from }))).toMatchObject(
        notPrepared,
      );
      expect(yield* Effect.flip(lease.writeTree({ prepared, from, to }))).toMatchObject(
        notPrepared,
      );

      // One for another workspace is refused.
      const foreign = yield* history.syncState.prepareWrite(
        lease,
        { ...key, workspaceId: (yield* identified(yield* otherLease)).workspaceId },
        { from: idle, to: writing },
      );
      expect(yield* Effect.flip(lease.writeTree({ prepared: foreign, from, to }))).toMatchObject(
        notPrepared,
      );
      expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("before\n");

      const current = yield* history.syncState.prepareWrite(lease, key, {
        from: writing,
        to: writing,
      });
      yield* lease.writeTree({ prepared: current, from, to });
      expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("after\n");
      // The write's own stage folder is gone with it.
      expect(
        (yield* f.fs.readDirectory(join(f.root, ".skit"))).filter((name) =>
          name.startsWith("stage-"),
        ),
      ).toEqual([]);
      // Used once, it is used up.
      expect(
        yield* Effect.flip(lease.writeTree({ prepared: current, from: to, to: from })),
      ).toMatchObject(notPrepared);
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
      const fromHash = yield* history.retain(from);
      const toHash = yield* history.retain(to);
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
        reason: expect.stringContaining("cannot contain descendants"),
      });
      expect(yield* f.fs.exists(join(home, "sync-bindings.json"))).toBe(false);
      expect(yield* f.fs.readFileString(join(f.root, "notes.txt"))).toBe("before\n");
    }).pipe(Effect.provide(authorLayer(home)));
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
