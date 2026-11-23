import { AuthorWorkspaceBusy } from "@smolai/skit-core/author/workspace-contracts";
import { encodeResult } from "../src/commands/encode-result.js";
import { SyncResult, syncOutputContracts } from "../src/library/sync/output.js";
import { it } from "@effect/vitest";
import { initializeAuthorWorkspace } from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { resolveSkitConfiguration, SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect, Fiber, FileSystem, Layer, Redacted, Result, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { syncAuthorWorkspace } from "../src/author/sync/workflow.js";
import { librarySyncCommand } from "../src/library/sync.js";
import { makeAuthorSyncServer } from "../src/platform/author-sync-fixture/server.js";
import { authorLayer } from "../src/platform/author-sync-fixture/history.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { copySkitFixtureEffect, scratch } from "./helpers/library-home.js";
import { librarySyncServer } from "./helpers/library-sync-server.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { testRoots } from "./helpers/roots.js";

const origin = "https://registry.example";
const auth = Result.succeed({ origin, token: "test-token", source: "stored" as const });

const world = (malformed = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratchRoot = yield* scratch("skit-library-author-sync-");
    const first = join(scratchRoot, "tools");
    const userA = join(scratchRoot, "a");
    const userB = join(scratchRoot, "b");
    const userC = join(scratchRoot, "c");
    const homeA = join(userA, ".skit");
    const homeB = join(userB, ".skit");
    const homeC = join(userC, ".skit");
    const second = join(userB, "skit", "registry.example", "swyx", "tools");
    const occupied = join(userC, "skit", "registry.example", "swyx", "tools");
    yield* copySkitFixtureEffect("authored", first);
    yield* fs.makeDirectory(userB, { recursive: true });
    yield* fs.makeDirectory(occupied, { recursive: true });
    yield* fs.writeFileString(join(occupied, "user.txt"), "keep\n");

    const author = yield* makeAuthorSyncServer();
    const library = librarySyncServer();
    const authorWrites: string[] = [];
    const libraryReads: string[] = [];
    const onDevice = <A, E, R>(
      userHome: string,
      home: string,
      device: "a" | "b" | "c",
      effect: Effect.Effect<A, E, R>,
    ) => {
      const transport: TestHttpHandler = (request, url, signal) => {
        if (
          url.pathname.startsWith("/api/library/") ||
          url.pathname.startsWith("/api/libraries/")
        ) {
          if (url.pathname === "/api/library/portable" && request.method === "GET")
            libraryReads.push(device);
          return Effect.sync(() => library.transport(request));
        }
        if (url.pathname === "/api/author/skits")
          return author.current().pipe(
            Effect.map((current) =>
              Response.json({
                skits: [
                  ...(malformed && current !== null
                    ? [
                        {
                          skit_id: "malformed",
                          visibility: "private",
                          current_revision_id: current,
                          current_revision_published: false,
                          most_recent_release_version: null,
                        },
                      ]
                    : []),
                  {
                    skit_id: "swyx/released",
                    visibility: "public",
                    current_revision_id: null,
                    current_revision_published: false,
                    most_recent_release_version: "1.0.0",
                  },
                  ...(current === null
                    ? []
                    : [
                        {
                          skit_id: "swyx/tools",
                          visibility: "private",
                          current_revision_id: current,
                          current_revision_published: false,
                          most_recent_release_version: null,
                        },
                      ]),
                ],
                next_cursor: null,
              }),
            ),
          );
        if (request.method !== "GET") authorWrites.push(device);
        return author.transport(device)(request, url, signal);
      };
      return effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.effect(
              SkitConfiguration,
              resolveSkitConfiguration(home, userHome).pipe(
                Effect.map((paths) => ({
                  ...paths,
                  registryOrigin: origin,
                  registryToken: Redacted.make("test-token"),
                })),
              ),
            ),
            authorLayer(home),
            Library.layer({ home, roots: testRoots(userHome) }),
            registryHttpLayer(testHttpClientLayer(transport)),
            rendererTestLayer(),
          ),
        ),
        Effect.scoped,
      );
    };
    const sync = (apply: boolean) => librarySyncCommand({ authState: auth, apply });
    yield* onDevice(
      userA,
      homeA,
      "a",
      Effect.gen(function* () {
        yield* initializeAuthorWorkspace(first, homeA);
        yield* syncAuthorWorkspace(first, {
          apply: true,
          home: homeA,
          to: `${origin}/swyx/tools`,
          visibility: "private",
        });
      }),
    );
    return {
      fs,
      scratchRoot,
      first,
      second,
      occupied,
      userA,
      userB,
      userC,
      homeA,
      homeB,
      homeC,
      onDevice,
      sync,
      authorWrites,
      author,
      libraryReads,
    };
  });

it.effect("names the authored Collection in plan data", () =>
  Effect.gen(function* () {
    const { onDevice, userA, homeA, sync } = yield* world();
    const initialPlan = yield* onDevice(userA, homeA, "a", sync(false));
    expect(initialPlan.plan?.remote).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "collection",
          label: "swyx/tools",
          source_kind: "authored-workspace",
        }),
      ]),
    );
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "previews and pulls a missing folder without uploading or creating another Collection",
  () =>
    Effect.gen(function* () {
      const { fs, first, second, onDevice, userB, homeB, sync, authorWrites, userA, homeA } =
        yield* world();
      expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
      const preview = yield* onDevice(userB, homeB, "b", sync(false));
      expect(preview.author_workspaces).toEqual([
        { identity: "skit://registry.example/swyx/tools", directory: second, status: "pull_ready" },
      ]);
      expect(yield* fs.exists(second)).toBe(false);
      const pulled = yield* onDevice(userB, homeB, "b", sync(true));
      expect(pulled.status).toBe("pulled");
      expect(pulled.author_workspaces).toEqual([expect.objectContaining({ status: "pulled" })]);
      expect(authorWrites).not.toContain("b");
      expect(yield* fs.readFileString(join(second, "skit.json"))).toEqual(
        yield* fs.readFileString(join(first, "skit.json")),
      );
      const list = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.gen(function* () {
          return yield* (yield* Library.Service).list();
        }),
      );
      expect(list.subjects).toHaveLength(1);
      expect(list.subjects[0]?.collectionSource).toMatchObject({
        locator: "",
        workspace_status: "unavailable",
      });
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("syncs an edit to the other device's folder", () =>
  Effect.gen(function* () {
    const { fs, first, second, onDevice, userB, homeB, sync, userA, homeA } = yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    yield* onDevice(userB, homeB, "b", sync(true));
    yield* fs.writeFileString(join(first, "notes.md"), "authored on a\n");
    const updated = yield* onDevice(userA, homeA, "a", sync(true));
    expect(updated.author_workspaces).toEqual([
      expect.objectContaining({
        status: "updated",
        sync: expect.objectContaining({ status: "pushed" }),
      }),
    ]);
    const received = yield* onDevice(userB, homeB, "b", sync(true));
    expect(received.author_workspaces).toEqual([
      expect.objectContaining({
        status: "sync",
        sync: expect.objectContaining({ status: "pulled" }),
      }),
    ]);
    expect(yield* fs.readFileString(join(second, "notes.md"))).toBe("authored on a\n");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("previews an incoming edit without writing files, history or Registry revisions", () =>
  Effect.gen(function* () {
    const { fs, first, second, onDevice, userB, homeB, sync, authorWrites, userA, homeA } =
      yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    yield* onDevice(userB, homeB, "b", sync(true));
    yield* fs.writeFileString(join(first, "notes.md"), "authored on a\n");
    const updated = yield* onDevice(userA, homeA, "a", sync(true));
    const database = join(homeB, "library.sqlite");
    const saved = yield* fs.readFile(database);
    const authorWriteCount = authorWrites.length;
    const behind = yield* onDevice(userB, homeB, "b", sync(false));
    expect(behind.author_workspaces).toEqual([
      expect.objectContaining({
        status: "sync",
        sync: expect.objectContaining({ action: "pull" }),
      }),
    ]);
    expect(yield* fs.exists(join(second, "notes.md"))).toBe(false);
    expect(yield* fs.readFile(database)).toEqual(saved);
    expect(authorWrites).toHaveLength(authorWriteCount);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("continues Library sync when an Author Workspace is busy", () =>
  Effect.gen(function* () {
    const { author, onDevice, userB, homeB, second, sync, libraryReads, userA, homeA } =
      yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    yield* onDevice(userB, homeB, "b", sync(true));
    const readsBeforeBusy = libraryReads.length;
    const busy = yield* Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* author.gate("b", "before-current");
        const manual = yield* onDevice(
          userB,
          homeB,
          "b",
          syncAuthorWorkspace(second, { home: homeB, apply: true }),
        ).pipe(Effect.forkScoped);
        yield* gate.reached();
        const result = yield* onDevice(userB, homeB, "b", sync(true));
        yield* gate.release();
        yield* Fiber.join(manual);
        return result;
      }),
    );
    expect(libraryReads.slice(readsBeforeBusy)).toContain("b");
    expect(busy.status).not.toBe("conflicted");
    const encoded = encodeResult("librarySync", syncOutputContracts.librarySync, busy);
    const decoded = Schema.decodeUnknownSync(SyncResult)(
      JSON.parse(JSON.stringify(encoded.encodedData)),
    );
    const failure = decoded.author_workspaces?.[0]?.failure;
    expect(decoded.author_workspaces?.[0]?.status).toBe("failed");
    expect(failure).toBeInstanceOf(AuthorWorkspaceBusy);
    expect(failure).toMatchObject({ root: yield* (yield* FileSystem.FileSystem).realPath(second) });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("does not recreate a deleted workspace with a checkpoint", () =>
  Effect.gen(function* () {
    const { fs, onDevice, userB, homeB, second, sync, userA, homeA } = yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    yield* onDevice(userB, homeB, "b", sync(true));
    yield* fs.remove(second, { recursive: true });
    expect((yield* onDevice(userB, homeB, "b", sync(true))).author_workspaces).toEqual([]);
    expect(yield* fs.exists(second)).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("leaves an occupied destination untouched", () =>
  Effect.gen(function* () {
    const { fs, onDevice, userC, homeC, occupied, sync, userA, homeA } = yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    const occupiedResult = yield* onDevice(userC, homeC, "c", sync(true));
    expect(occupiedResult.status).toBe("pulled");
    expect(Schema.encodeSync(SyncResult)(occupiedResult).author_workspaces).toEqual([
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({
          _tag: "PullDirectoryNotEmpty",
          path: expect.stringContaining("/swyx/tools"),
        }),
      }),
    ]);
    expect(yield* fs.readDirectory(occupied)).toEqual(["user.txt"]);
    expect(yield* fs.readFileString(join(occupied, "user.txt"))).toBe("keep\n");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("pulls under a symlinked skit directory", () =>
  Effect.gen(function* () {
    const { fs, scratchRoot, onDevice, sync, userA, homeA } = yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    const redirectedHome = join(scratchRoot, "redirected");
    const outside = join(scratchRoot, "outside");
    yield* fs.makeDirectory(redirectedHome);
    yield* fs.makeDirectory(outside);
    yield* fs.symlink(outside, join(redirectedHome, "skit"));
    const redirected = yield* onDevice(
      redirectedHome,
      join(redirectedHome, ".skit"),
      "c",
      sync(true),
    );
    expect(redirected.author_workspaces).toEqual([expect.objectContaining({ status: "pulled" })]);
    expect(yield* fs.exists(join(outside, "registry.example", "swyx", "tools", "skit.json"))).toBe(
      true,
    );
  }).pipe(Effect.provide(testPlatformLayer)),
);
it.effect("reports a malformed inventory entry and pulls the next SKIT", () =>
  Effect.gen(function* () {
    const { onDevice, userA, homeA, userB, homeB, sync } = yield* world(true);
    yield* onDevice(userA, homeA, "a", sync(true));
    const pulled = yield* onDevice(userB, homeB, "b", sync(true));
    expect(pulled.author_workspaces).toEqual([
      expect.objectContaining({
        identity: "malformed",
        status: "failed",
        failure: expect.objectContaining({ _tag: "AuthorDestinationInvalid" }),
      }),
      expect.objectContaining({ identity: "skit://registry.example/swyx/tools", status: "pulled" }),
    ]);
  }).pipe(Effect.provide(testPlatformLayer)),
);
