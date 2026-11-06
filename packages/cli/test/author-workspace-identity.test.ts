import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import * as History from "@smolai/skit-core/history";
import { AuthorHistory, AuthorWorkspace, type Identity } from "@smolai/skit-core/author";

/** No identity, typed as the state a first registration plans from. */
const absent = Option.none<Identity>();
import { authorLayer, captureWorkspace, storedTreesAt } from "./helpers/author-history.js";
import { libraryHome } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { captureDisk, assertDiskUnchanged } from "./helpers/disk-snapshot.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaces = yield* AuthorWorkspace;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-workspace-identity-" });
  const source = join(root, "skills");
  yield* fs.makeDirectory(join(source, "review"), { recursive: true });
  yield* fs.writeFileString(join(source, "review/SKILL.md"), "---\ninvalid: [\n");
  const home = yield* libraryHome({ home: join(root, "home") });
  /** Sync's identity step: an identity-only registration under the lease, used as is after. */
  const identify = (path = source) =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* workspaces.resolveRoot(path);
        const lease = yield* workspaces.acquire(workspace);
        const identity = yield* workspaces.readIdentity(workspace);
        return Option.isSome(identity)
          ? identity.value
          : yield* lease.register({ from: identity, to: "IdentityOnly", adopt: Option.none() });
      }),
    );
  const capture = (path = source) =>
    home.owned(captureWorkspace(path).pipe(Effect.provide(authorLayer(home.home))));
  const metadata = (path = source) =>
    fs.readFileString(join(path, ".skit/workspace.json")).pipe(Effect.map(JSON.parse));
  return { fs, workspaces, root, source, home, identify, capture, metadata };
});

it.effect("an identity-only registration writes no config, registration or Library entry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const identity = yield* f.identify();
    expect(identity.registration).toBe("IdentityOnly");
    expect(yield* f.fs.exists(join(f.source, "skit.json"))).toBe(false);
    expect(yield* f.fs.readFileString(join(f.source, "review/SKILL.md"))).toBe("---\ninvalid: [\n");
    expect(yield* f.fs.readFileString(join(f.source, ".skit/.gitignore"))).toBe("*\n");
    expect(yield* f.metadata()).toEqual({
      schema: "skit.author-workspace.v1",
      workspace_id: identity.workspaceId,
    });
    expect((yield* f.home.snapshot)._tag).toBe("Absent");
    const recorded = yield* f.capture();
    const trees = yield* storedTreesAt(f.home.home);
    expect(trees).toHaveLength(1);
    const saved = trees[0]?.tree.find((entry) => entry.path === "review/SKILL.md");
    expect(saved?.kind === "file" ? Buffer.from(saved.bytes).toString() : undefined).toBe(
      "---\ninvalid: [\n",
    );
    expect(yield* f.identify()).toEqual(identity);
    // The unchanged capture records nothing: it returns the revision already recorded.
    expect((yield* f.capture()).id).toBe(recorded.id);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an empty readable workspace receives identity without inventing content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(join(f.source, "review"), { recursive: true });
    yield* f.identify();
    expect(yield* f.fs.readDirectory(f.source)).toEqual([".skit"]);
    yield* f.capture();
    const trees = yield* storedTreesAt(f.home.home);
    expect(trees[0]?.tree).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("identity-only workspaces detect copies and retain identity when moved", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.identify();
    const firstCapture = yield* f.capture();
    const firstRoot = yield* f.workspaces.resolveRoot(f.source);
    const copy = join(f.root, "copy");
    yield* f.fs.copy(f.source, copy);
    const before = yield* captureDisk([copy], { identity: true });
    const collision = yield* Effect.flip(f.capture(copy));
    expect(collision).toMatchObject({
      _tag: "AuthorWorkspaceAlreadyRegistered",
      workspaceId: first.workspaceId,
      at: firstRoot,
    });
    expect("remediation" in collision ? collision.remediation : "").toContain("only in the copy");
    yield* assertDiskUnchanged(before);
    const moved = join(f.root, "moved");
    yield* f.fs.rename(f.source, moved);
    // An edit after the move saves a second revision under the same history.
    yield* f.fs.writeFileString(join(moved, "review/SKILL.md"), "edited after the move");
    expect((yield* f.identify(moved)).workspaceId).toBe(first.workspaceId);
    // The moved workspace continues its identity's history: the edit's parent is the first capture.
    const second = yield* f.capture(moved);
    expect(second.revision.parents).toEqual([firstCapture.id]);
    yield* f.fs.makeDirectory(f.source);
    expect((yield* f.identify()).workspaceId).not.toBe(first.workspaceId);
    const history = yield* Effect.gen(function* () {
      const store = (yield* AuthorHistory).engineStore;
      return yield* Stream.runCollect(History.ancestors(store, second.id));
    }).pipe(Effect.provide(authorLayer(f.home.home)));
    expect(history.map((entry) => entry.id)).toEqual([second.id, firstCapture.id]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("removal is durable intent, and a removed identity needs an explicit opt-in", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.identify();
    const root = yield* f.workspaces.resolveRoot(f.source);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* f.workspaces.acquire(root);
        const removing = yield* lease.register({
          from: { ...first, registration: "IdentityOnly" },
          to: "Removing",
        });
        expect((yield* f.metadata()).registration).toBe("removing");
        const removed = yield* lease.register({
          from: { ...removing, registration: "Removing" },
          to: "Removed",
        });
        expect((yield* f.metadata()).registration).toBe("removed");
        // The identity is unchanged, and a sync of a removed workspace uses it as it is.
        expect(removed.workspaceId).toBe(first.workspaceId);
        // A step planned from a state no longer on disk changes nothing.
        expect(
          yield* Effect.flip(
            lease.register({ from: { ...first, registration: "IdentityOnly" }, to: "Registered" }),
          ),
        ).toMatchObject({ _tag: "AuthorWorkspaceConflict" });
        const registered = yield* lease.register({
          from: { ...removed, registration: "Removed" },
          to: "Registered",
          optIn: true,
        });
        expect(registered).toEqual({ workspaceId: first.workspaceId, registration: "Registered" });
      }),
    );
    expect(yield* f.metadata()).toEqual({
      schema: "skit.author-workspace.v1",
      workspace_id: first.workspaceId,
      registration: "registered",
    });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an identity is never replaced, and an adopted id is used as given", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.identify();
    const root = yield* f.workspaces.resolveRoot(f.source);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* f.workspaces.acquire(root);
        if (Option.isSome(absent)) return;
        const conflict = yield* Effect.flip(
          lease.register({ from: absent, to: "Registered", adopt: Option.none() }),
        );
        expect(conflict).toMatchObject({ _tag: "AuthorWorkspaceConflict" });
        if (conflict._tag === "AuthorWorkspaceConflict")
          expect(conflict.found.identity).toEqual(Option.some(first));
      }),
    );
    const other = join(f.root, "other");
    yield* f.fs.makeDirectory(other);
    const adopted = yield* Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* f.workspaces.resolveRoot(other);
        const lease = yield* f.workspaces.acquire(workspace);
        if (Option.isSome(absent)) return yield* Effect.die("absent is None");
        return yield* lease.register({
          from: absent,
          to: "Registered",
          adopt: Option.some(first.workspaceId),
        });
      }),
    );
    expect(adopted).toEqual({ workspaceId: first.workspaceId, registration: "Registered" });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("identity registration leaves Git bytes, index and status untouched", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (...args: string[]) =>
      spawner.string(ChildProcess.make("git", args, { cwd: f.source }));
    yield* git("init", "-q");
    yield* f.fs.writeFileString(join(f.source, ".gitignore"), "scratch/\n");
    yield* git("add", ".");
    const status = yield* git("--no-optional-locks", "status", "--porcelain");
    const before = yield* captureDisk([join(f.source, ".git"), join(f.source, ".gitignore")], {
      identity: true,
    });
    yield* f.identify();
    yield* f.capture();
    expect(yield* git("--no-optional-locks", "status", "--porcelain")).toBe(status);
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "an unusable machine identity still preserves observed bytes before reporting failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(join(f.home.home, "machine.json"), "{broken machine settings");
      yield* f.identify();
      expect(yield* Effect.flip(f.capture())).toMatchObject({ _tag: "MachineSettingsUnusable" });
      const trees = yield* storedTreesAt(f.home.home);
      expect(trees).toHaveLength(1);
      const saved = trees[0]?.tree.find((entry) => entry.path === "review/SKILL.md");
      expect(saved?.kind === "file" ? Buffer.from(saved.bytes).toString() : undefined).toBe(
        "---\ninvalid: [\n",
      );
    }).pipe(Effect.provide(testPlatformLayer)),
);
