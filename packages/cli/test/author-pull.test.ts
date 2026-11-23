import { it } from "@effect/vitest";
import { join } from "node:path";
import { expect } from "vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";
import { pullAuthorSkit, syncAuthorWorkspace as syncWorkspace } from "@smolai/skit-core/author";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import { libraryLayer } from "../src/application.js";
import { syncAuthorWorkspace } from "../src/author/sync/workflow.js";
import { authorLayer } from "../src/platform/author-sync-fixture/history.js";
import { makeAuthorSyncServer } from "../src/platform/author-sync-fixture/server.js";
import { authorRegistry } from "../src/registry/author-sync.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { copySkitFixtureEffect, scratch } from "./helpers/library-home.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { registryCredentialLayer } from "./helpers/registry-credential.js";

/** One device: its own SKIT home, talking to the shared Registry over its own transport. */
const onDevice = <A, E, R>(
  home: string,
  transport: TestHttpHandler,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.provide(
      registryCredentialLayer("https://registry.example").pipe(
        Layer.provideMerge(registryHttpLayer(testHttpClientLayer(transport))),
        Layer.provideMerge(authorLayer(home)),
        Layer.provideMerge(libraryLayer().pipe(Layer.provide(skitConfigurationLayer(home)))),
      ),
    ),
    Effect.scoped,
  );

/** The error a pull failed with, or `undefined` when it succeeded. */
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  );

/** Every file under `root` outside the device-local `.skit` directory, by relative path. */
const authoredFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = (yield* fs.readDirectory(root, { recursive: true }))
    .filter((path) => path !== ".skit" && !path.startsWith(".skit/"))
    .sort();
  const files: Record<string, string> = {};
  for (const path of paths)
    if ((yield* fs.stat(join(root, path))).type === "File")
      files[path] = yield* fs.readFileString(join(root, path));
  return files;
});

it.effect("a second device pulls a synced SKIT into a new directory and is then in sync", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-author-pull-");
    const first = join(scratchRoot, "first");
    const second = join(scratchRoot, "second", "tools");
    const homeA = join(scratchRoot, "home-a");
    const homeB = join(scratchRoot, "home-b");
    yield* copySkitFixtureEffect("authored", first);
    const server = yield* makeAuthorSyncServer();
    const created = yield* onDevice(
      homeA,
      server.transport("a"),
      syncAuthorWorkspace(first, {
        home: homeA,
        to: "swyx/tools",
        visibility: "private",
        apply: true,
      }),
    );

    const writes: Array<string> = [];
    const pulled = yield* onDevice(
      homeB,
      (request, url, signal) => {
        if (request.method !== "GET") writes.push(`${request.method} ${url.pathname}`);
        return server.transport("b")(request, url, signal);
      },
      pullAuthorSkit("swyx/tools", { directory: second, home: homeB }, authorRegistry(homeB)),
    );

    // Receiving only: nothing is recorded on the Registry and `current` does not move.
    expect(writes).toEqual([]);

    expect(pulled).toMatchObject({
      identity: "skit://registry.example/swyx/tools",
      directory: yield* fs.realPath(second),
      revision_id: created.status === "created" ? created.revision_id : undefined,
    });
    expect(yield* authoredFiles(second)).toEqual(yield* authoredFiles(first));
    // Pull leaves the Library alone: no Collection is created for the new workspace.
    const claims = yield* onDevice(
      homeB,
      server.transport("b"),
      Effect.flatMap(Library.Service, (library) => library.workspaceClaims(pulled.directory)),
    );
    expect(claims.atRoot).toEqual([]);
    expect(
      yield* onDevice(
        homeB,
        server.transport("b"),
        syncAuthorWorkspace(second, { home: homeB, apply: true }),
      ),
    ).toMatchObject({ status: "up_to_date", revision_id: pulled.revision_id });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("pull refuses a directory that already holds files and leaves it alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-author-pull-occupied-");
    const first = join(scratchRoot, "first");
    const occupied = join(scratchRoot, "occupied");
    yield* copySkitFixtureEffect("authored", first);
    yield* fs.makeDirectory(occupied);
    yield* fs.writeFileString(join(occupied, "notes.md"), "mine\n");
    const server = yield* makeAuthorSyncServer();
    const homeA = join(scratchRoot, "home-a");
    yield* onDevice(
      homeA,
      server.transport("a"),
      syncAuthorWorkspace(first, {
        home: homeA,
        to: "swyx/tools",
        visibility: "private",
        apply: true,
      }),
    );
    const homeB = join(scratchRoot, "home-b");

    expect(
      yield* failure(
        onDevice(
          homeB,
          server.transport("b"),
          pullAuthorSkit("swyx/tools", { directory: occupied, home: homeB }, authorRegistry(homeB)),
        ),
      ),
    ).toMatchObject({ _tag: "PullDirectoryNotEmpty", path: occupied });
    expect(yield* fs.readDirectory(occupied)).toEqual(["notes.md"]);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("pull creates nothing when the SKIT has no revision", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-author-pull-empty-");
    const target = join(scratchRoot, "tools");
    const home = join(scratchRoot, "home");
    const transport: TestHttpHandler = () =>
      Effect.succeed(
        Response.json({ skit_id: "swyx/tools", current: null, visibility: "private" }),
      );

    expect(
      yield* failure(
        onDevice(
          home,
          transport,
          pullAuthorSkit("swyx/tools", { directory: target, home }, authorRegistry(home)),
        ),
      ),
    ).toMatchObject({ _tag: "NoRevisionToPull" });
    expect(yield* fs.exists(target)).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a file that appears while the Registry is asked is neither sent nor replaced", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-author-pull-race-");
    const first = join(scratchRoot, "first");
    const target = join(scratchRoot, "tools");
    yield* copySkitFixtureEffect("authored", first);
    const server = yield* makeAuthorSyncServer();
    const homeA = join(scratchRoot, "home-a");
    yield* onDevice(
      homeA,
      server.transport("a"),
      syncAuthorWorkspace(first, {
        home: homeA,
        to: "swyx/tools",
        visibility: "private",
        apply: true,
      }),
    );
    const homeB = join(scratchRoot, "home-b");
    const writes: Array<string> = [];
    const context = yield* Effect.context<FileSystem.FileSystem>();

    expect(
      yield* failure(
        onDevice(
          homeB,
          (request, url, signal) =>
            Effect.gen(function* () {
              if (request.method !== "GET") writes.push(`${request.method} ${url.pathname}`);
              // Someone else fills the directory after pull found it absent.
              yield* fs.makeDirectory(target, { recursive: true });
              yield* fs.writeFileString(join(target, "notes.md"), "mine\n");
              return yield* server.transport("b")(request, url, signal);
            }).pipe(Effect.provide(context), Effect.orDie),
          pullAuthorSkit("swyx/tools", { directory: target, home: homeB }, authorRegistry(homeB)),
        ),
      ),
    ).toMatchObject({ _tag: "PullDirectoryNotEmpty" });
    expect(writes).toEqual([]);
    expect(yield* fs.readFileString(join(target, "notes.md"))).toBe("mine\n");
    expect(yield* fs.exists(join(target, "skit.remote.json"))).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a receive-only sync refuses to send from a workspace that holds files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-author-receive-only-");
    const first = join(scratchRoot, "first");
    const other = join(scratchRoot, "other");
    yield* copySkitFixtureEffect("authored", first);
    const server = yield* makeAuthorSyncServer();
    const homeA = join(scratchRoot, "home-a");
    yield* onDevice(
      homeA,
      server.transport("a"),
      syncAuthorWorkspace(first, {
        home: homeA,
        to: "swyx/tools",
        visibility: "private",
        apply: true,
      }),
    );
    // A second folder names the same remote home and holds a file the Registry has never seen.
    yield* fs.makeDirectory(other);
    yield* fs.copyFile(join(first, "skit.remote.json"), join(other, "skit.remote.json"));
    yield* fs.writeFileString(join(other, "notes.md"), "mine\n");
    const homeB = join(scratchRoot, "home-b");
    const writes: Array<string> = [];

    expect(
      yield* failure(
        onDevice(
          homeB,
          (request, url, signal) => {
            if (request.method !== "GET") writes.push(`${request.method} ${url.pathname}`);
            return server.transport("b")(request, url, signal);
          },
          syncWorkspace(
            other,
            { apply: true, home: homeB, receiveOnly: true },
            authorRegistry(homeB),
          ),
        ),
      ),
    ).toMatchObject({ _tag: "PullDirectoryNotEmpty" });
    expect(writes).toEqual([]);
    expect((yield* fs.readDirectory(other)).filter((entry) => entry !== ".skit").sort()).toEqual([
      "notes.md",
      "skit.remote.json",
    ]);
  }).pipe(Effect.provide(testPlatformLayer)),
);
