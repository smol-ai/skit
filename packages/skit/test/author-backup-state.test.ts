import { expectTypeOf, test } from "vitest";
import type { AuthorHistoryShape } from "../src/author/history.js";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { AuthorHistory } from "../src/author/history.js";
import { AuthorWorkspace, WorkspaceId, type WorkspaceLease } from "../src/author/workspace.js";
import * as Sync from "../src/sync/sync.js";
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
      const before = yield* f.fs.readFileString(f.bindings);
      expect(
        yield* Effect.flip(history.backupState.save(lease, key, { from: null, to: b.id })),
      ).toMatchObject({ _tag: "AuthorHistoryInvalid" });
      expect(yield* f.fs.readFileString(f.bindings)).toBe(before);
      yield* history.backupState.save(lease, key, { from: null, to: a.id });
      yield* history.backupState.save(lease, key, { from: a.id, to: b.id });
      yield* history.backupState.save(lease, key, { from: b.id, to: again.id });
      expect(again.id).not.toBe(a.id);
      expect(again.treeHash).toBe(a.treeHash);
      expect(yield* history.syncState.read(key)).toEqual(sending);
      const saved = yield* f.fs.readFileString(f.bindings);
      const revision = yield* lease.revision;
      yield* history.backupState.save(lease, key, { from: again.id, to: again.id });
      expect(yield* lease.revision).toBe(revision);
      expect(yield* f.fs.readFileString(f.bindings)).toBe(saved);
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

for (const boundary of ["before-rename", "after-rename"] as const)
  it.effect(`backup acknowledgement survives restart ${boundary}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const recorded = yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const workspaces = yield* AuthorWorkspace;
        const root = yield* workspaces.resolveRoot(f.workspace);
        const lease = yield* workspaces.acquire(root);
        const { workspaceId } = yield* register(lease);
        const observation = yield* history.refresh(root);
        return { key: { workspaceId, locator }, id: observation.id };
      }).pipe(Effect.provide(ownerLayer(f.home)), Effect.scoped);
      let renamed = false;
      let stopped = false;
      const error = systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: f.bindings,
      });
      const files = FileSystem.FileSystem.of({
        ...f.fs,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (to === f.bindings && boundary === "before-rename") {
              stopped = true;
              return yield* error;
            }
            yield* f.fs.rename(from, to);
            if (to === f.bindings) renamed = true;
          }),
        open: (path, options) =>
          renamed && path === f.home
            ? Effect.sync(() => {
                stopped = true;
              }).pipe(Effect.andThen(Effect.fail(error)))
            : f.fs.open(path, options),
      });
      yield* Effect.gen(function* () {
        const workspaces = yield* AuthorWorkspace;
        const lease = yield* workspaces.acquire(yield* workspaces.resolveRoot(f.workspace));
        yield* (yield* AuthorHistory).backupState.save(lease, recorded.key, {
          from: null,
          to: recorded.id,
        });
      }).pipe(
        Effect.provide(ownerLayer(f.home)),
        Effect.provideService(FileSystem.FileSystem, files),
        Effect.scoped,
        Effect.flip,
      );
      expect(stopped).toBe(true);
      yield* Effect.gen(function* () {
        const history = yield* AuthorHistory;
        const found = yield* history.backupState.read(recorded.key);
        expect(found).toBe(boundary === "before-rename" ? null : recorded.id);
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
        const checkpoint = yield* f.fs.readFileString(f.bindings);
        expect(
          yield* Effect.flip(history.syncState.save(lease, key, { from: idle, to: sending })),
        ).toMatchObject({ _tag: "AuthorSyncStateConflict", found: writing });
        expect(yield* f.fs.readFileString(f.bindings)).toBe(checkpoint);
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

test("sync checkpoint types exclude null-base completion and caller-selected recovery destinations", () => {
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
  }>();
});
