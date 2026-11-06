import { testPlatformLayer } from "./helpers/platform.js";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect";
import { libraryApplicationLayer } from "../src/application.js";
import { syncAuthorWorkspace } from "../src/author/sync/workflow.js";
import { parseAuthorDestination } from "@smolai/skit-core/author";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer, type TestHttpHandler } from "./helpers/http-test-client.js";
import { registryCredentialLayer } from "./helpers/registry-credential.js";
import {
  copySkitFixtureEffect,
  initializeLibraryMachine,
  libraryHome,
  scratch,
} from "./helpers/library-home.js";
import { authorInitCommand } from "../src/author/init.js";
import { SkitConfiguration, skitConfigurationLayer } from "@smolai/skit-core/platform";
import { authorLayer, storedTreesAt } from "./helpers/author-history.js";
import { makeAuthorSyncServer } from "./helpers/author-sync-server.js";

/**
 * Run the native SKIT sync over one test's transport.
 *
 * A global stub cannot reach the client: `FetchHttpClient.Fetch` is a `Context.Reference` whose
 * default is computed once and cached on the Reference for the life of the process
 * (`Context.ts:1585`), so it captures whichever `globalThis.fetch` existed at first use. The
 * transport is provided as a Layer to the program instead.
 */
const runAuthorSync = (
  root: string,
  options: Parameters<typeof syncAuthorWorkspace>[1],
  transport: TestHttpHandler,
) =>
  Effect.gen(function* () {
    const historyHome = options.home ?? (yield* SkitConfiguration).skitHome;
    return yield* Effect.scoped(
      syncAuthorWorkspace(root, options).pipe(
        Effect.provide(registryHttpLayer(testHttpClientLayer(transport))),
        Effect.provide(authorLayer(historyHome)),
        // A first sync without workspace.json adopts an id from this home's Library (A3).
        Effect.provide(
          libraryApplicationLayer.pipe(Layer.provide(skitConfigurationLayer(historyHome))),
        ),
        // The environment's token is for the test Registry only.
        Effect.provide(registryCredentialLayer("https://registry.example")),
      ),
    );
  });

/** The error a sync failed or died with, or `undefined` when it succeeded. */
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  );

const fs = FileSystem.FileSystem;
const writeText = (path: string, text: string) =>
  Effect.flatMap(fs, (fs) => fs.writeFileString(path, text));
const readText = (path: string) => Effect.flatMap(fs, (fs) => fs.readFileString(path));
const makeDir = (path: string) =>
  Effect.flatMap(fs, (fs) => fs.makeDirectory(path, { recursive: true }));
const exists = (path: string) => Effect.flatMap(fs, (fs) => fs.exists(path));

it.effect("first sync previews then records one remote home without publishing it", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-first-sync-test-");
    const home = yield* scratch("skit-first-sync-home-");
    yield* makeDir(join(root, "skills", "review"));
    yield* writeText(
      join(root, "skit.json"),
      `${JSON.stringify(
        {
          slug: "tools",
          skills: [
            {
              name: "review",
              path: "skills/review",
              invocation: "explicit",
              capabilities: ["filesystem_read"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );
    yield* makeDir(join(root, ".skit"));
    yield* writeText(join(root, ".skit", "device.json"), '{"device":"local"}\n');
    yield* makeDir(join(root, "skills", "review", ".skit"));
    yield* writeText(join(root, "skills", "review", ".skit", "fixture.txt"), "included\n");
    yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", root]));
    yield* writeText(join(root, ".gitignore"), "device-local.json\n");
    yield* writeText(join(root, "device-local.json"), '{"local":true}\n');
    yield* writeText(join(root, "new-author-content.md"), "included before commit\n");

    const server = yield* makeAuthorSyncServer();
    const writes: Array<string> = [];
    const transport: TestHttpHandler = (request, url, signal) => {
      if (request.method !== "GET") writes.push(`${request.method} ${url.pathname}`);
      return server.transport("a")(request, url, signal);
    };
    const options = {
      home,
      to: "swyx/tools",
      visibility: "private" as const,
    };

    expect(yield* runAuthorSync(root, { ...options, apply: false }, transport)).toMatchObject({
      status: "first_sync_ready",
      changed: false,
      identity: { locator: "skit://registry.example/swyx/tools" },
    });
    expect(writes).toEqual([]);
    expect(yield* exists(join(root, "skit.remote.json"))).toBe(false);
    expect(yield* exists(join(root, ".skit/connection.json"))).toBe(false);

    expect(yield* runAuthorSync(root, { ...options, apply: true }, transport)).toMatchObject({
      status: "created",
      changed: true,
      remote_home_recorded: true,
      published: false,
    });
    // Create, preserve the raw observation, send the normalized current revision, then move. No Release.
    expect(writes).toEqual([
      "POST /api/skits",
      "POST /api/skits/swyx/tools/revisions",
      "POST /api/skits/swyx/tools/revisions",
      "PUT /api/skits/swyx/tools/current",
    ]);
    const [created] = yield* server.currentHistory();
    expect(yield* server.current()).toBe(created?.id);
    const paths = created?.tree.map((entry) => entry.path) ?? [];
    expect(paths).not.toContain("skit.remote.json");
    expect(paths).not.toContain(".skit/device.json");
    expect(paths).not.toContain(".skit/workspace.json");
    expect(paths).not.toContain("device-local.json");
    expect(paths).toContain("new-author-content.md");
    expect(paths).toContain("skills/review/.skit/fixture.txt");
    expect(JSON.parse(yield* readText(join(root, "skit.remote.json")))).toEqual({
      schema: "skit.remote.v1",
      origin: "https://registry.example",
      namespace: "swyx",
      skit: "tools",
    });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a first sync without workspace.json reuses the id its authored Collection carries", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-sync-adopt-");
    const source = join(root, "source");
    yield* copySkitFixtureEffect("authored", source);
    const library = yield* libraryHome({ home: join(root, "home") });
    yield* initializeLibraryMachine(library.home);
    const imported = yield* library.owned(authorInitCommand(source, false));
    const metadata = join(source, ".skit", "workspace.json");
    const { workspace_id } = JSON.parse(yield* readText(metadata));
    expect(imported.entry?.collection.upstream?.source_identity).toEqual({
      kind: "authored-workspace",
      workspace_id,
    });
    yield* Effect.flatMap(fs, (fs) => fs.remove(metadata));

    const server = yield* makeAuthorSyncServer();
    expect(
      yield* runAuthorSync(
        source,
        { home: library.home, to: "swyx/tools", visibility: "private", apply: true },
        server.transport("a"),
      ),
    ).toMatchObject({ status: "created" });
    // Backed up under the Library's id, as identity only: sync never registers for installation.
    expect(JSON.parse(yield* readText(metadata))).toEqual({
      schema: "skit.author-workspace.v1",
      workspace_id,
    });
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("a pending first connection cannot be redirected or change visibility", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-pending-sync-test-");
    const home = yield* scratch("skit-pending-sync-home-");
    yield* copySkitFixtureEffect("authored", root);
    const server = yield* makeAuthorSyncServer();
    const transport = server.transport("a");
    const options = {
      apply: true,
      home,
      to: "swyx/tools",
      visibility: "private" as const,
    };
    yield* server.dropNextResponse("a", "after-create");
    yield* Effect.result(runAuthorSync(root, options, transport));
    const path = join(
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(root)),
      ".skit/connection.json",
    );
    const pending = yield* readText(path);
    const events = yield* server.events();
    expect(
      yield* Effect.flip(runAuthorSync(root, { ...options, to: "swyx/other" }, transport)),
    ).toMatchObject({ _tag: "AuthorRemoteAlreadyExists" });
    expect(
      yield* Effect.flip(runAuthorSync(root, { ...options, visibility: "public" }, transport)),
    ).toMatchObject({ _tag: "VisibilityNotAccepted" });
    expect(yield* readText(path)).toBe(pending);
    expect(yield* server.events()).toEqual(events);
    expect(yield* server.revisions()).toHaveLength(0);
    // A damaged receipt must fail closed, with its bytes available for repair.
    yield* writeText(path, "{unfinished");
    expect(yield* Effect.flip(runAuthorSync(root, { apply: true, home }, transport))).toMatchObject(
      { _tag: "AuthorSyncStateInvalid", path },
    );
    expect(yield* readText(path)).toBe("{unfinished");
    expect(yield* server.events()).toEqual(events);
    yield* writeText(path, pending);
    expect((yield* runAuthorSync(root, { apply: true, home }, transport)).status).toBe("created");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("first sync distinguishes credential scope from Namespace authority", () =>
  Effect.gen(function* () {
    for (const [serverError, tag] of [
      ["insufficient_scope", "CredentialLacksScope"],
      ["forbidden", "PrincipalNotAuthorized"],
    ] as const) {
      const root = yield* scratch(`skit-first-sync-${serverError}-`);
      yield* copySkitFixtureEffect("authored", root);
      const transport: TestHttpHandler = (request) =>
        Effect.succeed(
          request.method === "GET"
            ? Response.json({ error: "skit_not_found" }, { status: 404 })
            : Response.json({ error: serverError }, { status: 403 }),
        );

      expect(
        yield* failure(
          runAuthorSync(
            root,
            {
              apply: true,
              to: "tim/tools",
              visibility: "private",
            },
            transport,
          ),
        ),
      ).toMatchObject({ _tag: tag });
      expect(yield* exists(join(root, "skit.remote.json"))).toBe(false);
    }

    // A 404 without the Registry's reason is not proof the SKIT is missing: nothing is created.
    const root = yield* scratch("skit-first-sync-bare-not-found-");
    yield* copySkitFixtureEffect("authored", root);
    let writes = 0;
    expect(
      yield* failure(
        runAuthorSync(
          root,
          {
            apply: true,
            to: "tim/tools",
            visibility: "private",
          },
          (request) =>
            Effect.sync(() => {
              if (request.method !== "GET") writes++;
              return new Response(null, { status: 404 });
            }),
        ),
      ),
    ).toMatchObject({ _tag: "SyncRejected" });
    expect(writes).toBe(0);
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("author destinations are Registry-qualified", () =>
  Effect.gen(function* () {
    expect(yield* parseAuthorDestination("tim/tools", "https://registry.example/path")).toEqual({
      schema: "skit.remote.v1",
      origin: "https://registry.example",
      namespace: "tim",
      skit: "tools",
    });
    expect(yield* parseAuthorDestination("skit://other.example/tim/tools")).toMatchObject({
      origin: "https://other.example",
    });
    expect(yield* parseAuthorDestination("https://other.example/tim/tools")).toMatchObject({
      origin: "https://other.example",
    });
  }),
);

it.effect("sync sends the whole tree, skit.json included, and leaves human-owned files", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-json-sync-test-");
    const home = yield* scratch("skit-json-sync-home-");
    yield* makeDir(join(root, "skills", "review"));
    yield* writeText(join(root, "README.md"), "# Human-owned tools documentation\n");
    const config = `${JSON.stringify(
      {
        slug: "tools",
        skills: [
          {
            name: "review",
            path: "skills/review",
            invocation: "explicit",
            capabilities: ["filesystem_read"],
          },
        ],
      },
      null,
      2,
    )}\n`;
    yield* writeText(join(root, "skit.json"), config);
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );
    const server = yield* makeAuthorSyncServer();
    const options = { apply: true, home };

    expect(
      yield* runAuthorSync(
        root,
        { ...options, to: "swyx/tools", visibility: "private" },
        server.transport("a"),
      ),
    ).toMatchObject({ status: "created" });
    const edited = "---\nname: review\ndescription: Review code.\n---\n# Locally edited review\n";
    yield* writeText(join(root, "skills", "review", "SKILL.md"), edited);
    expect(yield* runAuthorSync(root, options, server.transport("a"))).toMatchObject({
      status: "pushed",
    });
    const current = yield* server.current();
    const pushed = (yield* server.revisions()).find(({ id }) => id === current);
    const text = (path: string) => {
      const entry = pushed?.tree.find((candidate) => candidate.path === path);
      return entry?.kind === "file" ? Buffer.from(entry.bytes).toString() : undefined;
    };
    expect(text("skit.json")).toBe(config);
    expect(text("skills/review/SKILL.md")).toBe(edited);
    expect(yield* readText(join(root, "README.md"))).toBe("# Human-owned tools documentation\n");
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect("an interrupted sync aborts its SKIT request without recording a binding", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-sync-interrupt-");
    const home = yield* scratch("skit-sync-interrupt-home-");
    yield* copySkitFixtureEffect("authored", root);
    let aborted = false;
    const reached = yield* Deferred.make<void>();
    // The SKIT read never answers, so the only way out is the interrupt.
    const transport: TestHttpHandler = () =>
      Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted = true;
          }),
        ),
      );

    const fiber = yield* Effect.forkScoped(
      runAuthorSync(
        root,
        {
          apply: true,
          home,
          to: "tim/tools",
          visibility: "private",
        },
        transport,
      ),
    );
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(fiber);

    // The request belongs to the workflow's Scope: the promise implementation had no owner to
    // cancel it, and left the read to settle on its own.
    expect(aborted).toBe(true);
    expect(yield* exists(join(home, "sync-bindings.json"))).toBe(false);
    expect(yield* exists(join(root, "skit.remote.json"))).toBe(false);
    // The observed tree was saved on this device before sync spoke to the Registry.
    expect(
      (yield* storedTreesAt(home)).some(({ tree }) =>
        tree.some((entry) => entry.path === "skit.json"),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(testPlatformLayer)),
);
