import { AuthorWorkspaceBusy } from "@smolai/skit-core/author/workspace-contracts";
import { encodeResult } from "../src/commands/encode-result.js";
import { SyncResult, syncOutputContracts } from "../src/library/sync/output.js";
import { it } from "@effect/vitest";
import {
  initializeAuthorWorkspace,
  pullAuthorSkit,
  refreshAuthorWorkspace,
} from "@smolai/skit-core/author";
import * as Library from "@smolai/skit-core/library";
import { resolveSkitConfiguration, SkitConfiguration } from "@smolai/skit-core/platform";
import { Clock, Effect, Fiber, FileSystem, Layer, Redacted, Result, Schema } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { authorRegistry } from "../src/registry/author-sync.js";
import { updateAdapters } from "../src/library/update/adapters.js";
import { inspectLibrarySource } from "../src/library/source.js";
import { authorSyncCommand } from "../src/author/sync.js";
import { installEnabledSkills } from "./helpers/installed-skills.js";
import { libraryHome, writingTo } from "./helpers/library-home.js";
import { syncAuthorWorkspace } from "../src/author/sync/workflow.js";
import { librarySyncApi } from "../src/library/sync/api.js";
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

const world = (malformed = false, secondSkill = false) =>
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
    if (secondSkill) {
      yield* fs.makeDirectory(join(first, "skills/explain"), { recursive: true });
      const review = yield* fs.readFileString(join(first, "skills/review/SKILL.md"));
      yield* fs.writeFileString(
        join(first, "skills/explain/SKILL.md"),
        review.replaceAll("review", "explain"),
      );
      const descriptor = join(first, "skit.json");
      const skit = JSON.parse(yield* fs.readFileString(descriptor));
      skit.skills.push({ ...skit.skills[0], name: "explain", path: "skills/explain" });
      yield* fs.writeFileString(descriptor, JSON.stringify(skit));
    }
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
      offline = false,
    ) => {
      const transport: TestHttpHandler = (request, url, signal) => {
        if (offline) return Effect.succeed(new Response(null, { status: 503 }));
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
        yield* authorSyncCommand({
          root: first,
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
          authority: origin,
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
      // Both simulated devices can stat A’s folder. Only A may claim that path.
      const claims = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.flatMap(Library.Service, (library) => library.workspaceClaims(first)),
      );
      expect(claims.atRoot).toEqual([]);
      const reinitialized = yield* onDevice(
        userB,
        homeB,
        "b",
        initializeAuthorWorkspace(second, homeB),
      );
      expect(reinitialized.entry.collection.collection_id).toBe(list.collections[0]?.id);
      const after = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.flatMap(Library.Service, (library) => library.list()),
      );
      expect(after.collections).toHaveLength(1);
      expect(list.subjects).toHaveLength(1);
      expect(list.subjects[0]?.collectionSource).toMatchObject({
        locator: yield* fs.realPath(second),
        workspace_status: "connected",
        name: "swyx/tools",
        authority: origin,
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
        status: "updated",
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

it.effect("omits a deleted workspace from preview and does not recreate it on apply", () =>
  Effect.gen(function* () {
    const { fs, onDevice, userB, homeB, second, sync, userA, homeA } = yield* world();
    expect((yield* onDevice(userA, homeA, "a", sync(true))).status).toBe("pushed");
    yield* onDevice(userB, homeB, "b", sync(true));
    yield* fs.remove(second, { recursive: true });
    expect((yield* onDevice(userB, homeB, "b", sync(false))).author_workspaces).toEqual([]);
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

for (const scope of ["author", "device"] as const) {
  it.effect(`refreshes enabled harness bytes after a ${scope} sync receives a remote edit`, () =>
    Effect.gen(function* () {
      const { fs, first, second, userA, homeA, userB, homeB, onDevice, sync } = yield* world();
      const library = yield* libraryHome({ home: homeA });
      const state = yield* library.durable;
      const skill = state?.skills[0];
      if (!skill) throw new Error("Expected an imported skill");
      yield* library.enable([{ skill: skill.skill_id }]);
      const root = join(testRoots(userA).home, ".agents", "skills");
      yield* writingTo(
        homeA,
        installEnabledSkills({ target: "agents", root, variantsPath: join(homeA, "variants") }),
      );
      const file = join("skills", "review", "SKILL.md");
      const before = yield* fs.readFileString(join(first, file));
      const installed = join(root, "review", "SKILL.md");
      const projected = yield* fs.readFileString(installed);
      yield* onDevice(userA, homeA, "a", sync(true));
      yield* onDevice(userB, homeB, "b", sync(true));
      const edited = before + "\nRemote edit\n";
      yield* fs.writeFileString(join(second, file), edited);
      yield* onDevice(userB, homeB, "b", sync(true));
      if (scope === "author")
        yield* onDevice(
          userA,
          homeA,
          "a",
          authorSyncCommand({ root: first, home: homeA, apply: true }),
        );
      else yield* onDevice(userA, homeA, "a", sync(true));
      expect(yield* fs.readFileString(installed)).toBe(projected + "\nRemote edit\n");
    }).pipe(Effect.provide(testPlatformLayer)),
  );
}

it.effect(
  "a pulled workspace updates its enabled skills offline and retains last-valid bytes",
  () =>
    Effect.gen(function* () {
      const { fs, first, second, userA, homeA, userB, homeB, onDevice, sync } = yield* world(
        false,
        true,
      );
      const a = yield* libraryHome({ home: homeA });
      const collectionId = (yield* a.durable)!.collections[0]!.collection_id;
      yield* a.enable([{ collection: collectionId }]);
      yield* onDevice(userA, homeA, "a", sync(true));
      yield* onDevice(userB, homeB, "b", sync(true));
      // B has its own import, then A publishes the newest import. Refresh only
      // B’s Library to leave its workspace untouched until the offline edit.
      yield* onDevice(userB, homeB, "b", initializeAuthorWorkspace(second, homeB));
      const reviewFile = join(first, "skills/review/SKILL.md");
      const aOriginal = yield* fs.readFileString(reviewFile);
      yield* fs.writeFileString(reviewFile, aOriginal + "\nA updated the skill\n");
      yield* onDevice(userA, homeA, "a", sync(true));
      yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.gen(function* () {
          const library = yield* Library.Service;
          yield* library.sync(
            { origin, apply: true },
            yield* librarySyncApi({ origin, token: "test-token" }),
          );
          const listed = yield* library.list();
          expect(listed.collections[0]?.collectionSource?.locator).toBe(yield* fs.realPath(second));
        }),
      );
      const root = join(testRoots(userB).home, ".agents", "skills");
      const installed = (name: string) => join(root, name, "SKILL.md");
      const valid = yield* fs.readFileString(installed("review"));
      expect(valid).toContain("A updated the skill");
      const held = yield* fs.readFileString(installed("explain"));
      const file = "skills/review/SKILL.md";
      const original = yield* fs.readFileString(join(first, file));
      yield* fs.writeFileString(join(second, file), original + "\nOffline edit\n");
      yield* fs.writeFileString(join(second, "skills/explain/SKILL.md"), "# broken");
      const preview = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.flatMap(Library.Service, (library) =>
          library.previewSourceUpdates(collectionId, inspectLibrarySource),
        ),
      );
      expect(preview[0]?.updated).toContain("review");
      expect(
        preview[0]?.issues?.some((issue) => "skill" in issue && issue.skill === "explain"),
      ).toBe(true);
      const updated = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.gen(function* () {
          return yield* (yield* Library.Service).update(collectionId, yield* updateAdapters);
        }),
        true,
      );
      expect(updated).toHaveLength(1);
      expect(yield* fs.readFileString(installed("review"))).toBe(valid + "\nOffline edit\n");
      expect(yield* fs.readFileString(installed("explain"))).toBe(held);
      expect(yield* fs.readFileString(join(first, file))).toBe(original);
      const b = yield* libraryHome({ home: homeB });
      expect((yield* b.durable)!.collections.map((c) => c.collection_id)).toEqual([collectionId]);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "ignores stale Draft checkpoints and refuses registration at either ambiguous live clone",
  () =>
    Effect.gen(function* () {
      const { fs, first, second, userA, homeA, userB, homeB, onDevice, sync } = yield* world();
      yield* onDevice(userA, homeA, "a", sync(true));
      yield* onDevice(userB, homeB, "b", sync(true));
      const clone = join(userB, "clone");
      yield* onDevice(
        userB,
        homeB,
        "b",
        pullAuthorSkit("swyx/tools", { directory: clone, home: homeB }, authorRegistry(homeB)),
      );
      const listed = yield* onDevice(
        userB,
        homeB,
        "b",
        Effect.flatMap(Library.Service, (library) => library.list()),
      );
      expect(listed.collections[0]?.collectionSource?.workspace_status).toBe("ambiguous");
      for (const root of [second, clone]) {
        const error = yield* onDevice(
          userB,
          homeB,
          "b",
          initializeAuthorWorkspace(root, homeB).pipe(Effect.flip),
        );
        expect(error._tag).toBe("DirectoryAlreadyInLibrary");
      }
      yield* fs.rename(second, second + "-old");
      const alias = join(userB, "alias");
      yield* fs.symlink(clone, alias);
      const b = yield* onDevice(userB, homeB, "b", initializeAuthorWorkspace(alias, homeB));
      const a = yield* libraryHome({ home: homeA });
      expect(b.entry.collection.collection_id).toBe(
        (yield* a.durable)!.collections[0]!.collection_id,
      );
      yield* fs.writeFileString(join(clone, "skit.remote.json"), "{");
      const other = join(userB, "unrelated");
      yield* copySkitFixtureEffect("authored", other);
      yield* onDevice(userB, homeB, "b", initializeAuthorWorkspace(other, homeB));
      expect(yield* fs.exists(join(first, "skit.json"))).toBe(true);
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect(
  "independent imports of one connected Draft converge on the Registry collection handle",
  () =>
    Effect.gen(function* () {
      const { second, userA, homeA, userB, homeB, onDevice, sync } = yield* world();
      yield* onDevice(
        userB,
        homeB,
        "b",
        pullAuthorSkit("swyx/tools", { directory: second, home: homeB }, authorRegistry(homeB)),
      );
      yield* onDevice(userB, homeB, "b", initializeAuthorWorkspace(second, homeB));
      yield* onDevice(userA, homeA, "a", sync(true));
      const merged = yield* onDevice(userB, homeB, "b", sync(true));
      expect(["merged", "pulled", "clean", "pushed"]).toContain(merged.status);
      const a = yield* libraryHome({ home: homeA });
      const b = yield* libraryHome({ home: homeB });
      expect((yield* b.durable)!.collections.map((c) => c.collection_id)).toEqual(
        (yield* a.durable)!.collections.map((c) => c.collection_id),
      );
    }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("converges overlapping offline edits without a second Library conflict", () =>
  Effect.gen(function* () {
    const { fs, first, second, userA, homeA, userB, homeB, onDevice, sync } = yield* world();
    const a = yield* libraryHome({ home: homeA });
    const id = (yield* a.durable)!.collections[0]!.collection_id;
    yield* a.enable([{ collection: id }]);
    yield* onDevice(userA, homeA, "a", sync(true));
    yield* onDevice(userB, homeB, "b", sync(true));
    const file = "skills/review/SKILL.md";
    const initial = yield* fs.readFileString(join(first, file));
    const update = Effect.gen(function* () {
      return yield* (yield* Library.Service).update(id, yield* updateAdapters);
    });
    const offlineVersions = new Set<string>();
    const offlineCopies = new Set<string>();
    for (const [device, user, home, root] of [
      ["a", userA, homeA, first],
      ["b", userB, homeB, second],
    ] as const) {
      yield* fs.writeFileString(join(root, file), initial + device + "\n");
      // Capture A’s file edit first, then let its Library report a future import time.
      // Observation time in the Library must not choose the Draft on either device.
      yield* onDevice(user, home, device, refreshAuthorWorkspace(root));
      const offlineUpdate =
        device === "a"
          ? update.pipe(
              Effect.updateService(Clock.Clock, (clock) => ({
                ...clock,
                currentTimeMillis: clock.currentTimeMillis.pipe(
                  Effect.map((time) => time + 86_400_000),
                ),
              })),
            )
          : update;
      yield* onDevice(user, home, device, offlineUpdate, true);
      const saved = (yield* (yield* libraryHome({ home })).durable)!;
      for (const version of saved.skills[0]!.versions)
        offlineVersions.add(version.skill_version_id);
      for (const source of saved.imports) offlineCopies.add(source.collection_version_id);
      expect(
        yield* fs.readFileString(join(testRoots(user).home, ".agents/skills/review/SKILL.md")),
      ).toContain("\n" + device + "\n");
    }
    yield* onDevice(userA, homeA, "a", sync(true));
    // Let B retrieve A's later-dated Library history before it can reach the Draft.
    const caughtUp = yield* onDevice(
      userB,
      homeB,
      "b",
      Effect.gen(function* () {
        return yield* (yield* Library.Service).sync(
          { origin, apply: true },
          yield* librarySyncApi({ origin, token: "test-token" }),
        );
      }),
    );
    expect(["clean", "pulled", "merged", "pushed"]).toContain(caughtUp.status);
    expect(
      yield* fs.readFileString(join(testRoots(userB).home, ".agents/skills/review/SKILL.md")),
    ).toContain("\nb\n");
    const stateB = (yield* (yield* libraryHome({ home: homeB })).durable)!;
    const selected = stateB.imports.find((item) =>
      stateB.local_draft_imports?.includes(item.import_id),
    )!;
    const tree = stateB.collection_versions.find(
      (item) => item.collection_version_id === selected.collection_version_id,
    )!;
    const checks = yield* onDevice(
      userB,
      homeB,
      "b",
      Effect.flatMap(Library.Service, (library) =>
        library.check(id, { inspectSource: () => Effect.succeed({ snapshot_digest: tree.hash }) }),
      ),
    );
    expect(checks[0]?.current_snapshot_digest).toBe(tree.hash);
    const reports = yield* onDevice(userB, homeB, "b", update, true);
    expect(reports[0]).toMatchObject({
      changed: false,
      selected_collection_version_id: tree.collection_version_id,
      snapshot_digest: tree.hash,
    });
    for (const [device, user, home] of [
      ["b", userB, homeB],
      ["a", userA, homeA],
      ["b", userB, homeB],
      ["a", userA, homeA],
    ] as const) {
      const result = yield* onDevice(user, home, device, sync(true));
      expect(result.conflict_details ?? []).toEqual([]);
      expect(["clean", "merged", "pushed", "pulled"]).toContain(result.status);
    }
    const accepted = yield* fs.readFileString(join(first, file));
    expect([initial + "a\n", initial + "b\n"]).toContain(accepted);
    expect(yield* fs.readFileString(join(second, file))).toBe(accepted);
    for (const [user, home, device] of [
      [userA, homeA, "a"],
      [userB, homeB, "b"],
    ] as const) {
      expect(
        yield* fs.readFileString(join(testRoots(user).home, ".agents/skills/review/SKILL.md")),
      ).toContain(accepted.slice(initial.length - 1));
      const saved = (yield* (yield* libraryHome({ home })).durable)!;
      const portable = yield* onDevice(
        user,
        home,
        device,
        Effect.flatMap(Library.Service, (library) => library.manifest),
      );
      expect(portable).not.toHaveProperty("local_draft_imports");
      expect(saved.skills[0]!.versions.map((v) => v.skill_version_id)).toEqual(
        expect.arrayContaining([...offlineVersions]),
      );
      expect(saved.collection_versions.map((v) => v.collection_version_id)).toEqual(
        expect.arrayContaining([...offlineCopies]),
      );
      expect((yield* onDevice(user, home, device, sync(true))).status).toBe("clean");
    }
  }).pipe(Effect.provide(testPlatformLayer)),
);
