import { LinkStat } from "@smolai/skit-core/platform";
import { dirname, join } from "node:path";
import { Effect, Exit, Fiber, FileSystem, Layer, Ref, Scope } from "effect";
import { libraryApplicationLayer } from "../../src/application.js";

import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { AuthorWorkspace, AuthorHistory } from "@smolai/skit-core/author";
import { Option } from "effect";
import { backupAuthorHistory } from "../../src/author/sync/backup.js";
import { authorSyncApi } from "../../src/registry/author-sync.js";
import type { PlatformError } from "effect/PlatformError";
import { syncAuthorWorkspace } from "../../src/author/sync/workflow.js";
import { authorLayer, storedTreesAt } from "./author-history.js";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { testHttpClientLayer } from "./http-test-client.js";
import { registryCredentialLayer } from "./registry-credential.js";
import { makeAuthorSyncServer, type AuthorDevice } from "./author-sync-server.js";
import { missingAuthorVersions, type AuthorCopy, type AuthorEdit } from "./author-sync-oracle.js";

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
export const makeAuthorSyncWorld = Effect.fn("Test.makeAuthorSyncWorld")(function* () {
  const fs = yield* FileSystem.FileSystem;
  // Canonical, as the workspace owner resolves it, so tests can match the paths it writes.
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-world-" }),
  );
  const server = yield* makeAuthorSyncServer();
  const edits = yield* Ref.make<ReadonlyArray<AuthorEdit>>([]);

  const scan: (
    directory: string,
    prefix?: string,
  ) => Effect.Effect<Array<{ path: string; bytes: Uint8Array }>, PlatformError> = Effect.fn(
    "Test.scanAuthorFiles",
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

  const makeDevice = Effect.fn("Test.makeAuthorDevice")(function* (name: AuthorDevice) {
    const workspace = join(root, name, "workspace");
    const home = join(root, name, "home");
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
    const startSync = Effect.fn("Test.startAuthorSync")(function* (
      first = false,
      apply = true,
      allowLargeDeletion = false,
    ) {
      return yield* Effect.forkIn(
        Effect.scoped(
          syncAuthorWorkspace(workspace, {
            apply,
            allowLargeDeletion,
            home,
            ...(first ? { to: "swyx/tools", visibility: "private" as const } : {}),
          }).pipe(
            Effect.provide(registryHttpLayer(testHttpClientLayer(server.transport(name)))),
            // Fresh, so the author owners write through a FileSystem a test provides here.
            Effect.provide(authorLayer(home)),
            // The Library's layer carries its own FileSystem; sync keeps the test's.
            Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
            Effect.provideService(LinkStat, yield* LinkStat),
            // A first sync without workspace.json adopts an id from this home's Library (A3).
            Effect.provide(
              libraryApplicationLayer.pipe(Layer.provide(skitConfigurationLayer(home))),
            ),
            // The environment's token is for the test Registry only.
            Effect.provide(registryCredentialLayer(remote.origin)),
          ),
        ),
        yield* Ref.get(runtime),
      );
    });
    return {
      name,
      workspace,
      home,
      startSync,
      /** Complete archival uploads before a test pauses the separate current-content protocol. */
      backUp: () =>
        Effect.gen(function* () {
          const workspaces = yield* AuthorWorkspace;
          const root = yield* workspaces.resolveRoot(workspace);
          const lease = yield* workspaces.acquire(root);
          const identity = yield* workspaces.readIdentity(root);
          if (Option.isNone(identity))
            return yield* Effect.die("Expected connected fixture identity");
          const observation = yield* (yield* AuthorHistory).capture(root);
          const api = yield* authorSyncApi({
            remote,
            locator: "skit://registry.example/swyx/tools",
          });
          yield* backupAuthorHistory(
            lease,
            {
              workspaceId: identity.value.workspaceId,
              locator: "skit://registry.example/swyx/tools",
            },
            observation,
            api.remote,
          );
        }).pipe(
          Effect.provide(registryHttpLayer(testHttpClientLayer(server.transport(name)))),
          Effect.provide(authorLayer(home)),
          Effect.scoped,
        ),
      sync: (first = false, allowLargeDeletion = false) =>
        startSync(first, true, allowLargeDeletion).pipe(Effect.flatMap(Fiber.join)),
      preview: () => startSync(false, false).pipe(Effect.flatMap(Fiber.join)),
      restart: Effect.fn("Test.restartAuthorDevice")(function* () {
        yield* Scope.close(yield* Ref.get(runtime), Exit.void);
        yield* Ref.set(runtime, yield* Scope.make());
      }),
      read: (path: string) => fs.readFileString(join(workspace, path)),
      files: () => scan(workspace),
      edit: Effect.fn("Test.editAuthorFile")(function* (
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
    connect: Effect.fn("Test.connectAuthorDevices")(function* () {
      yield* a.sync(true);
      for (const device of [b, c])
        yield* fs.writeFileString(
          join(device.workspace, "skit.remote.json"),
          JSON.stringify(remote),
        );
      yield* b.sync();
      // C has the portable destination but no merge base: tests can exercise a late join.
    }),
    copies: Effect.fn("Test.readAuthorCopies")(function* () {
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
