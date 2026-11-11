import { LinkStat } from "@smolai/skit-core/platform";
import { dirname, join } from "node:path";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Ref, Scope } from "effect";
import * as Library from "@smolai/skit-core/library";
import {
  backupAuthorWorkspace,
  watchAuthorWorkspace,
  type AuthorWatchEvent,
  initializeAuthorWorkspace,
} from "@smolai/skit-core/author";
import { authorRegistry, authorSyncApi } from "../../registry/author-sync.js";
import type { PlatformError } from "effect/PlatformError";
import { syncAuthorWorkspace } from "../../author/sync/workflow.js";
import { authorLayer, storedTreesAt } from "./history.js";
import { registryHttpLayer } from "../../registry/registry-http.js";
import { testHttpClientLayer } from "./transport.js";
import { registryCredentialLayer } from "./transport.js";
import { makeAuthorSyncServer, type AuthorDevice } from "./server.js";
import { missingAuthorVersions, type AuthorCopy, type AuthorEdit } from "./oracle.js";

const remote = {
  schema: "skit.remote.v1",
  origin: "https://registry.example",
  namespace: "swyx",
  skit: "tools",
} as const;

/**
 * Owns isolated real directories and restartable runtime scopes. A restart closes fibers but
 * keeps the filesystem and remote. Allocate this INSIDE each property evaluation, including
 * shrinking attempts; a suite-shared Layer would let one case contaminate the next.
 */
export const makeAuthorSyncWorld = Effect.fn("Fixture.makeAuthorSyncWorld")(function* (
  directory?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // Canonical, as the workspace owner resolves it, so tests can match the paths it writes.
  const root = yield* fs.realPath(
    directory ?? (yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-world-" })),
  );
  const server = yield* makeAuthorSyncServer();
  const edits = yield* Ref.make<ReadonlyArray<AuthorEdit>>([]);

  const scan: (
    directory: string,
    prefix?: string,
  ) => Effect.Effect<Array<{ path: string; bytes: Uint8Array }>, PlatformError> = Effect.fn(
    "Fixture.scanAuthorFiles",
  )(function* (directory, prefix = "") {
    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    for (const name of (yield* fs.readDirectory(directory)).sort()) {
      if (prefix === "" && (name === "skit.remote.json" || name === ".skit")) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const info = yield* fs.stat(absolute);
      if (info.type === "Directory") files.push(...(yield* scan(absolute, path)));
      else if (info.type === "File") files.push({ path, bytes: yield* fs.readFile(absolute) });
    }
    return files;
  });

  const makeDevice = Effect.fn("Fixture.makeAuthorDevice")(function* (name: AuthorDevice) {
    const workspace = join(root, name, "workspace");
    const home = join(root, name, "home");
    const installed = join(root, name, "agents");
    const library = Library.layer({
      home,
      roots: {
        home: join(root, name, "device-home"),
        configHome: join(root, name, "config"),
        overrides: { codex: [installed] },
      },
    });
    yield* fs.makeDirectory(join(workspace, "skills/review"), { recursive: true });
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fs.writeFileString(
      join(workspace, "skit.json"),
      JSON.stringify({
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            invocation: "explicit",
            capabilities: ["filesystem_read"],
          },
        ],
      }),
    );
    yield* fs.writeFileString(
      join(workspace, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );
    const runtime = yield* Ref.make(yield* Scope.make());
    yield* Effect.addFinalizer(() =>
      Ref.get(runtime).pipe(Effect.flatMap((scope) => Scope.close(scope, Exit.void))),
    );
    const startSync = Effect.fn("Fixture.startAuthorSync")(function* (
      first = false,
      apply = true,
      allowLargeDeletion = false,
      confirmRemovals = false,
    ) {
      return yield* Effect.forkIn(
        Effect.scoped(
          syncAuthorWorkspace(workspace, {
            apply,
            confirmRemovals,
            allowLargeDeletion,
            home,
            ...(first ? { to: "swyx/tools", visibility: "private" as const } : {}),
          }).pipe(
            // This is the command's Registry environment; the Library's home layer must not replace it.
            Effect.provide(
              registryCredentialLayer(remote.origin).pipe(
                Layer.provideMerge(registryHttpLayer(testHttpClientLayer(server.transport(name)))),
                // Fresh, so the author owners write through a FileSystem a test provides here.
                Layer.provideMerge(authorLayer(home)),
              ),
            ),
            // The Library's layer carries its own FileSystem; sync keeps the test's.
            Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
            Effect.provideService(LinkStat, yield* LinkStat),
            // A first sync without workspace.json adopts an id from this home's Library (A3).
            Effect.provide(library),
          ),
        ),
        yield* Ref.get(runtime),
      );
    });
    return {
      name,
      workspace,
      home,
      installed: (path: string) => fs.readFileString(join(installed, path)),
      registerAndEnable: () =>
        Effect.gen(function* () {
          const imported = yield* initializeAuthorWorkspace(workspace, home);
          const owner = yield* Library.Service;
          const base = yield* owner.read;
          const plan = yield* owner.plan(
            {
              _tag: "Enabled",
              changes: [
                {
                  _tag: "Enable",
                  subject: { _tag: "Collection", id: imported.entry.collection.collection_id },
                  members: "whole",
                  where: [{ kind: "global" }],
                },
              ],
            },
            { base },
          );
          yield* owner.apply({ _tag: "Apply", plan });
        }).pipe(Effect.scoped, Effect.provide(library.pipe(Layer.provideMerge(authorLayer(home))))),
      startSync,
      startWatch: (report: (event: AuthorWatchEvent) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          return yield* Effect.forkIn(
            watchAuthorWorkspace(workspace, { home }, authorRegistry(home), report).pipe(
              Effect.provide(
                registryCredentialLayer(remote.origin).pipe(
                  Layer.provideMerge(
                    registryHttpLayer(testHttpClientLayer(server.transport(name))),
                  ),
                  Layer.provideMerge(authorLayer(home)),
                ),
              ),
              Effect.provide(library),
            ),
            yield* Ref.get(runtime),
          );
        }),
      /** Complete archival uploads before a test pauses the separate current-content protocol. */
      backUp: () =>
        Effect.gen(function* () {
          const api = yield* authorSyncApi({
            remote,
            locator: "skit://registry.example/swyx/tools",
          });
          yield* backupAuthorWorkspace(workspace, api.remote);
        }).pipe(
          Effect.provide(
            registryHttpLayer(testHttpClientLayer(server.transport(name))).pipe(
              Layer.provideMerge(authorLayer(home)),
            ),
          ),
          Effect.scoped,
        ),
      sync: (first = false, allowLargeDeletion = false, confirmRemovals = false) =>
        startSync(first, true, allowLargeDeletion, confirmRemovals).pipe(
          Effect.flatMap(Fiber.join),
        ),
      preview: () => startSync(false, false).pipe(Effect.flatMap(Fiber.join)),
      restart: Effect.fn("Fixture.restartAuthorDevice")(function* () {
        yield* Scope.close(yield* Ref.get(runtime), Exit.void);
        yield* Ref.set(runtime, yield* Scope.make());
      }),
      remove: (path: string) => fs.remove(join(workspace, path), { recursive: true }),
      exists: (path: string) => fs.exists(join(workspace, path)),
      readCheckpoint: () => fs.readFileString(join(home, "author-sync.json")),
      writeCheckpoint: (content: string) =>
        fs.writeFileString(join(home, "author-sync.json"), content),
      saveAtomically: Effect.fn("Fixture.saveAtomically")(function* (
        path: string,
        content: string,
      ) {
        const target = join(workspace, path);
        yield* fs.writeFileString(`${target}.tmp`, content);
        yield* fs.rename(`${target}.tmp`, target);
      }),
      startSyncPausingAfterWrite: Effect.fn("Fixture.startSyncPausingAfterWrite")(function* (
        path: string,
      ) {
        const written = yield* Deferred.make<void>();
        const pending = yield* startSync().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            link: Effect.fn(function* (from, to) {
              yield* fs.link(from, to);
              if (to.endsWith(`/${path}`)) {
                yield* Deferred.succeed(written, undefined);
                return yield* Effect.never;
              }
            }),
          }),
        );
        return { pending, written: Deferred.await(written) };
      }),
      read: (path: string) => fs.readFileString(join(workspace, path)),
      files: () => scan(workspace),
      edit: Effect.fn("Fixture.editAuthorFile")(function* (
        path: string,
        content: string,
        recovery: AuthorEdit["recovery"] = "anywhere",
      ) {
        // These are editor operations, not sync acknowledgements. Recording an expectation
        // does NOT save a backup; the oracle's input cannot count as a recoverable copy.
        const absolute = join(workspace, path);
        yield* fs.makeDirectory(dirname(absolute), { recursive: true });
        yield* fs.writeFileString(absolute, content);
        yield* Ref.update(edits, (items) => [
          ...items,
          { id: items.length + 1, device: name, path, bytes: Buffer.from(content), recovery },
        ]);
      }),
    };
  });

  const a = yield* makeDevice("a");
  const b = yield* makeDevice("b");
  const c = yield* makeDevice("c");
  const devices = [a, b, c];

  return {
    a,
    b,
    c,
    server,
    connect: Effect.fn("Fixture.connectAuthorDevices")(function* () {
      yield* a.sync(true);
      for (const device of [b, c])
        yield* fs.writeFileString(
          join(device.workspace, "skit.remote.json"),
          JSON.stringify(remote),
        );
      yield* b.sync();
      // C has the portable destination but no merge base: tests can exercise a late join.
    }),
    copies: Effect.fn("Fixture.readAuthorCopies")(function* () {
      const copies: AuthorCopy[] = [];
      for (const device of devices) {
        copies.push({ location: device.name, kind: "workspace", files: yield* device.files() });
        for (const stored of yield* storedTreesAt(device.home))
          copies.push({
            location: `${device.name}:${stored.hash}`,
            kind: "local-history",
            files: stored.tree.flatMap((entry) =>
              entry.kind === "file" ? [{ path: entry.path, bytes: entry.bytes }] : [],
            ),
          });
      }
      for (const revision of yield* server.revisions())
        copies.push({
          location: revision.id,
          kind: "remote",
          files: revision.tree.flatMap((entry) =>
            entry.kind === "file" ? [{ path: entry.path, bytes: entry.bytes }] : [],
          ),
        });
      return copies;
    }),
    missing: (copies: ReadonlyArray<AuthorCopy>) =>
      Ref.get(edits).pipe(Effect.map((items) => missingAuthorVersions(items, copies))),
  };
});
