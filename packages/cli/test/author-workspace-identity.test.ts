import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Deferred, Fiber } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { withLibraryWriter } from "@smolai/skit-core";
import { ensureAuthorWorkspaceIdentity } from "../src/workflows/author/workspace-identity.js";
import { loadAuthorWorkspaceMetadata } from "../src/library/author-workspace-metadata.js";
import {
  loadAuthorHistory,
  loadStoredTrees,
  refreshAuthorHistory,
} from "../src/workflows/author/history.js";
import { libraryHome } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { captureDisk, assertDiskUnchanged } from "./helpers/disk-snapshot.js";
import { systemError } from "effect/PlatformError";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-workspace-identity-" });
  const source = join(root, "skills");
  yield* fs.makeDirectory(join(source, "review"), { recursive: true });
  yield* fs.writeFileString(join(source, "review/SKILL.md"), "---\ninvalid: [\n");
  const home = yield* libraryHome({ home: join(root, "home") });
  const ensure = (path = source, register = false) =>
    home.owned(ensureAuthorWorkspaceIdentity(path, { register }));
  return { fs, root, source, home, ensure };
});

it.effect("plain invalid skills connect with recovery history, no config or Library import", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.ensure();
    expect(first.status).toBe("ready");
    expect(yield* f.fs.exists(join(f.source, "skit.json"))).toBe(false);
    expect(yield* f.fs.readFileString(join(f.source, "review/SKILL.md"))).toBe("---\ninvalid: [\n");
    expect(yield* f.fs.readFileString(join(f.source, ".skit/.gitignore"))).toBe("*\n");
    expect(yield* loadAuthorWorkspaceMetadata(f.source)).toMatchObject({
      workspace_id: first.workspace_id,
      registration: "registered",
    });
    const state = yield* f.home.durable;
    expect(state.collections).toEqual([]);
    expect(state.collection_versions).toEqual([]);
    const trees = yield* f.home.owned(loadStoredTrees(f.home.home));
    expect(trees).toHaveLength(1);
    const saved = trees[0]?.tree.find((entry) => entry.path === "review/SKILL.md");
    expect(saved?.kind === "file" ? Buffer.from(saved.bytes).toString() : undefined).toBe(
      "---\ninvalid: [\n",
    );
    expect(yield* f.ensure()).toEqual(first);
    expect(yield* f.home.owned(loadAuthorHistory(f.source, f.home.home))).toHaveLength(1);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an empty readable workspace receives identity without inventing content", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.remove(join(f.source, "review"), { recursive: true });
    expect((yield* f.ensure()).status).toBe("ready");
    expect(yield* f.fs.readDirectory(f.source)).toEqual([".skit"]);
    const trees = yield* f.home.owned(loadStoredTrees(f.home.home));
    expect(trees[0]?.tree).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("identity-only workspaces detect copies and retain identity when moved", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.ensure();
    const copy = join(f.root, "copy");
    yield* f.fs.copy(f.source, copy);
    const before = yield* captureDisk([copy], { identity: true });
    const collision = yield* Effect.flip(f.ensure(copy));
    expect(collision).toMatchObject({
      _tag: "AuthorWorkspaceAlreadyRegistered",
      workspaceId: first.workspace_id,
      at: first.root,
    });
    expect("remediation" in collision ? collision.remediation : "").toContain("only in the copy");
    yield* assertDiskUnchanged(before);
    const moved = join(f.root, "moved");
    yield* f.fs.rename(f.source, moved);
    // An edit after the move saves a second revision under the same history.
    yield* f.fs.writeFileString(join(moved, "review/SKILL.md"), "edited after the move");
    expect((yield* f.ensure(moved)).workspace_id).toBe(first.workspace_id);
    yield* f.fs.makeDirectory(f.source);
    expect((yield* f.ensure()).workspace_id).not.toBe(first.workspace_id);
    expect(
      (yield* f.home.owned(loadAuthorHistory(moved, f.home.home))).map((event) => event.sequence),
    ).toEqual([1, 2]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("removed identity stays opted out until explicitly registered again", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.ensure();
    const path = join(f.source, ".skit/workspace.json");
    yield* f.fs.writeFileString(
      path,
      JSON.stringify({
        schema: "skit.author-workspace.v1",
        workspace_id: first.workspace_id,
        registration: "removed",
      }),
    );
    yield* f.fs.writeFileString(join(f.source, "review/SKILL.md"), "new unobserved bytes");
    expect((yield* f.ensure()).status).toBe("removed");
    expect(yield* f.home.owned(loadAuthorHistory(f.source, f.home.home))).toHaveLength(1);
    expect((yield* f.ensure(f.source, true)).workspace_id).toBe(first.workspace_id);
    expect(yield* f.home.owned(loadAuthorHistory(f.source, f.home.home))).toHaveLength(2);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "failed registration after capture safely retries the same identity and observation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = join(yield* f.fs.realPath(f.source), ".skit/workspace.json");
      const result = yield* Effect.result(
        f.ensure().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              to === path
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                    }),
                  )
                : f.fs.rename(from, to),
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
      const pending = yield* loadAuthorWorkspaceMetadata(f.source);
      expect(pending?.registration).toBeUndefined();
      expect((yield* f.ensure()).workspace_id).toBe(pending?.workspace_id);
      expect(yield* f.home.owned(loadAuthorHistory(f.source, f.home.home))).toHaveLength(1);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("identity connection leaves Git bytes, index and status untouched", () =>
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
    yield* f.ensure();
    expect(yield* git("--no-optional-locks", "status", "--porcelain")).toBe(status);
    yield* assertDiskUnchanged(before);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "recording under a Library writer cannot deadlock with another recorder creating identity",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const start = yield* Deferred.make<void>();
      const readIdentity = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let firstRead = true;
      // Fork before taking the writer, so this recorder inherits no writer lease.
      const other = yield* Effect.forkChild(
        Deferred.await(start).pipe(
          Effect.andThen(
            f.home.owned(refreshAuthorHistory(f.source, f.home.home)).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...f.fs,
                readFileString: (path, options) =>
                  Effect.gen(function* () {
                    if (path.endsWith("/machine.json") && firstRead) {
                      firstRead = false;
                      const result = yield* Effect.result(f.fs.readFileString(path, options));
                      yield* Deferred.succeed(readIdentity, undefined);
                      yield* Deferred.await(proceed);
                      return yield* Effect.fromResult(result);
                    }
                    return yield* f.fs.readFileString(path, options);
                  }),
              }),
            ),
          ),
        ),
      );
      yield* f.home.owned(
        withLibraryWriter(
          Effect.gen(function* () {
            yield* Deferred.succeed(start, undefined);
            yield* Deferred.await(readIdentity);
            yield* Deferred.succeed(proceed, undefined);
            yield* refreshAuthorHistory(f.source, f.home.home);
          }),
        ),
      );
      yield* Fiber.join(other);
      expect(yield* f.home.owned(loadAuthorHistory(f.source, f.home.home))).toHaveLength(1);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "an unusable machine identity still preserves observed bytes before reporting failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(join(f.home.home, "machine.json"), "{broken machine settings");
      expect(yield* Effect.flip(f.ensure())).toMatchObject({ _tag: "MachineSettingsUnusable" });
      expect((yield* loadAuthorWorkspaceMetadata(f.source))?.registration).toBeUndefined();
      const trees = yield* f.home.owned(loadStoredTrees(f.home.home));
      expect(trees).toHaveLength(1);
      const saved = trees[0]?.tree.find((entry) => entry.path === "review/SKILL.md");
      expect(saved?.kind === "file" ? Buffer.from(saved.bytes).toString() : undefined).toBe(
        "---\ninvalid: [\n",
      );
    }).pipe(Effect.provide(testPlatformLayer)),
);
