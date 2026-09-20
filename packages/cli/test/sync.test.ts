import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { parseAuthorDestination, syncDraftEffect } from "../src/workflows/author/sync.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { fetchTestClientLayer } from "./helpers/http-test-client.js";
import { copySkitFixtureEffect, scratch } from "./helpers/library-home.js";

/**
 * Run the native Draft sync over one test's transport.
 *
 * A global stub cannot reach the client: `FetchHttpClient.Fetch` is a `Context.Reference` whose
 * default is computed once and cached on the Reference for the life of the process
 * (`Context.ts:1585`), so it captures whichever `globalThis.fetch` existed at first use. The
 * transport is provided as a Layer to the program instead.
 */
const syncDraft = (
  root: string,
  options: Parameters<typeof syncDraftEffect>[1],
  transport: typeof fetch,
) =>
  Effect.scoped(
    syncDraftEffect(root, options).pipe(
      Effect.provide(registryHttpLayer(fetchTestClientLayer(transport))),
    ),
  );

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

const digest = `sha256:${"a".repeat(64)}`;

/**
 * The request payload, however the transport chose to carry it.
 *
 * Effect's HTTP client sends an encoded body and names the method on every request, including
 * reads; these tests distinguish the Draft read from a write by the method itself rather than by
 * the absence of one.
 */
function payload(init?: RequestInit): string {
  const body = init?.body;
  if (body === undefined || body === null) return "";
  return typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
}
const isWrite = (init?: RequestInit) => init?.method !== undefined && init.method !== "GET";

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
    yield* writeText(join(root, ".skit", "workspace.json"), '{"device":"local"}\n');
    yield* makeDir(join(root, "skills", "review", ".skit"));
    yield* writeText(join(root, "skills", "review", ".skit", "fixture.txt"), "included\n");
    yield* Effect.sync(() => execFileSync("git", ["init", "--quiet", root]));
    yield* writeText(join(root, ".gitignore"), "device-local.json\n");
    yield* writeText(join(root, "device-local.json"), '{"local":true}\n');
    yield* writeText(join(root, "new-author-content.md"), "included before commit\n");

    let posts = 0;
    let createBody: {
      descriptor: { id: string };
      visibility: string;
      files: Array<{ path: string }>;
    };
    const transport = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!isWrite(init)) return Response.json({ error: "draft_not_found" }, { status: 404 });
      posts++;
      createBody = JSON.parse(payload(init));
      return Response.json(
        {
          draft: {
            skit_id: "tim/tools",
            revision_id: "draft_first",
            manifest_digest: digest,
            bundle_digest: digest,
            files: [],
            diagnostics: [],
          },
        },
        { status: 201 },
      );
    };

    expect(
      yield* syncDraft(
        root,
        {
          apply: false,
          home,
          baseUrl: "https://registry.example",
          to: "tim/tools",
          visibility: "private",
        },
        transport,
      ),
    ).toMatchObject({
      status: "first_sync_ready",
      changed: false,
      identity: { locator: "skit://registry.example/tim/tools" },
    });
    expect(posts).toBe(0);
    expect(yield* exists(join(root, "skit.remote.json"))).toBe(false);

    expect(
      yield* syncDraft(
        root,
        {
          apply: true,
          home,
          baseUrl: "https://registry.example",
          to: "tim/tools",
          visibility: "private",
        },
        transport,
      ),
    ).toMatchObject({
      status: "created",
      changed: true,
      remote_home_recorded: true,
      published: false,
    });
    expect(posts).toBe(1);
    expect(createBody!).toMatchObject({ descriptor: { id: "tim/tools" }, visibility: "private" });
    expect(createBody!.files.map(({ path }) => path)).not.toContain("skit.remote.json");
    expect(createBody!.files.map(({ path }) => path)).not.toContain(".skit/workspace.json");
    expect(createBody!.files.map(({ path }) => path)).not.toContain("device-local.json");
    expect(createBody!.files.map(({ path }) => path)).toContain("new-author-content.md");
    expect(createBody!.files.map(({ path }) => path)).toContain("skills/review/.skit/fixture.txt");
    expect(JSON.parse(yield* readText(join(root, "skit.remote.json")))).toEqual({
      schema: "skit.remote.v1",
      origin: "https://registry.example",
      namespace: "tim",
      skit: "tools",
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("first sync distinguishes credential scope from Namespace authority", () =>
  Effect.gen(function* () {
    for (const [serverError, message] of [
      ["insufficient_scope", "lacks authoring:write"],
      ["forbidden", "not authorized to author this Namespace or SKIT"],
    ] as const) {
      const root = yield* scratch(`skit-first-sync-${serverError}-`);
      yield* copySkitFixtureEffect("authored", root);
      const transport = async (_input: RequestInfo | URL, init?: RequestInit) =>
        isWrite(init)
          ? Response.json({ error: serverError }, { status: 403 })
          : Response.json({ error: "draft_not_found" }, { status: 404 });

      expect(
        yield* failure(
          syncDraft(
            root,
            {
              apply: true,
              baseUrl: "https://registry.example",
              to: "tim/tools",
              visibility: "private",
            },
            transport,
          ),
        ),
      ).toMatchObject({ message: expect.stringContaining(message) });
    }

    const root = yield* scratch("skit-first-sync-bare-not-found-");
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        syncDraft(
          root,
          {
            apply: true,
            baseUrl: "https://registry.example",
            to: "tim/tools",
            visibility: "private",
          },
          async () => new Response(null, { status: 404 }),
        ),
      ),
    ).toMatchObject({ message: expect.stringContaining("draft read failed (404)") });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("author destinations are Registry-qualified", () =>
  Effect.sync(() => {
    expect(parseAuthorDestination("tim/tools", "https://registry.example/path")).toEqual({
      schema: "skit.remote.v1",
      origin: "https://registry.example",
      namespace: "tim",
      skit: "tools",
    });
    expect(parseAuthorDestination("skit://other.example/tim/tools")).toMatchObject({
      origin: "https://other.example",
    });
    expect(parseAuthorDestination("https://other.example/tim/tools")).toMatchObject({
      origin: "https://other.example",
    });
  }),
);

it.effect("sync apply reads identity and Skill declarations from a merged skit.json tree", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-json-sync-test-");
    const home = yield* scratch("skit-json-sync-home-");
    yield* makeDir(join(root, "skills", "review"));
    yield* writeText(join(root, "README.md"), "# Human-owned tools documentation\n");
    const config = {
      slug: "tools",
      skills: [
        {
          name: "review",
          path: "skills/review",
          invocation: "explicit",
          capabilities: ["filesystem_read"],
        },
      ],
    };
    yield* writeText(join(root, "skit.json"), `${JSON.stringify(config, null, 2)}\n`);
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );

    let baseFiles: Array<{
      path: string;
      content_base64: string;
      media_type: string;
      executable?: boolean;
    }> = [];
    let created = false;
    let updateBody: { descriptor?: { id?: string } } | undefined;
    const transport = async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!created && !isWrite(init))
        return Response.json({ error: "draft_not_found" }, { status: 404 });
      if (init?.method === "POST") {
        baseFiles = JSON.parse(payload(init)).files;
        created = true;
        return Response.json(
          {
            draft: {
              skit_id: "test/tools",
              revision_id: "draft_1",
              manifest_digest: digest,
              bundle_digest: digest,
              files: [],
              diagnostics: [],
            },
          },
          { status: 201 },
        );
      }
      if (init?.method === "PUT") {
        updateBody = JSON.parse(payload(init));
        return Response.json({
          draft: {
            skit_id: "test/tools",
            revision_id: "draft_2",
            manifest_digest: digest,
            bundle_digest: digest,
            files: [],
            diagnostics: [],
          },
        });
      }
      return Response.json({
        draft: {
          revision_id: "draft_1",
          bundle_digest: digest,
          title: "tools",
          visibility: "private",
          descriptor: {
            skit: 1,
            id: "test/tools",
            slug: "tools",
            skills: config.skills.map((skill) => ({ ...skill, default_enabled: true })),
          },
          diagnostics: [],
          files: baseFiles.map((file) => ({ ...file, executable: false })),
        },
      });
    };

    expect(
      yield* syncDraft(
        root,
        {
          apply: true,
          home,
          baseUrl: "https://registry.example",
          to: "test/tools",
          visibility: "private",
        },
        transport,
      ),
    ).toMatchObject({ status: "created" });
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Locally edited review\n",
    );
    expect(
      yield* syncDraft(root, { apply: true, home, baseUrl: "https://registry.example" }, transport),
    ).toMatchObject({ status: "merged" });
    expect(updateBody?.descriptor).toMatchObject({ id: "test/tools", slug: "tools" });
    expect(yield* readText(join(root, "README.md"))).toBe("# Human-owned tools documentation\n");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an interrupted sync aborts its in-flight Draft request and writes nothing", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-sync-interrupt-");
    const home = yield* scratch("skit-sync-interrupt-home-");
    yield* copySkitFixtureEffect("authored", root);
    let aborted = false;
    const reached = yield* Deferred.make<void>();
    // The Draft read never answers, so the only way out is the interrupt.
    const transport = async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal!.reason);
          },
          { once: true },
        );
        Deferred.doneUnsafe(reached, Exit.void);
      });

    const fiber = yield* Effect.forkScoped(
      syncDraft(
        root,
        {
          apply: true,
          home,
          baseUrl: "https://registry.example",
          to: "tim/tools",
          visibility: "private",
        },
        transport,
      ),
    );
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(fiber);

    // The request belongs to the workflow's Scope: the promise implementation had no signal to
    // cancel, and left the read to settle on its own.
    expect(aborted).toBe(true);
    expect(yield* exists(join(home, "sync-bindings.json"))).toBe(false);
    expect(yield* exists(join(root, "skit.remote.json"))).toBe(false);
  }).pipe(Effect.provide(skitLayer)),
);
