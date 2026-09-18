import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Schema } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { publishEffect } from "../src/workflows/author/publish.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { fetchTestClientLayer } from "./helpers/http-test-client.js";
import { copySkitFixtureEffect, scratch } from "./helpers/library-home.js";

/**
 * Run the native publication with an injected Registry transport.
 *
 * Production's publication takes no fetch: the transport is a Layer, so the seam belongs here
 * rather than in a parameter that only tests pass.
 */
const publish = (
  root: string,
  version: string,
  revision: string | undefined,
  options: { fetch: typeof fetch; baseUrl?: string; token?: string },
) =>
  publishEffect(root, version, revision, {
    baseUrl: options.baseUrl,
    token: options.token,
  }).pipe(Effect.provide(registryHttpLayer(fetchTestClientLayer(options.fetch))));

/** The error a publication failed or died with, or `undefined` when it succeeded. */
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  );

const fs = FileSystem.FileSystem;
const writeText = (path: string, text: string) =>
  Effect.flatMap(fs, (fs) => fs.writeFileString(path, text));
const readText = (path: string) => Effect.flatMap(fs, (fs) => fs.readFileString(path));
const writeBytes = (path: string, bytes: Uint8Array) =>
  Effect.flatMap(fs, (fs) => fs.writeFile(path, bytes));
const makeDir = (path: string) =>
  Effect.flatMap(fs, (fs) => fs.makeDirectory(path, { recursive: true }));
const listDir = (path: string) => Effect.flatMap(fs, (fs) => fs.readDirectory(path));

const writeRemote = (root: string, origin = "https://registry.test") =>
  writeText(
    join(root, "skit.remote.json"),
    `${JSON.stringify({ schema: "skit.remote.v1", origin, namespace: "test", skit: "tools" })}\n`,
  );

const unzipList = (archive: string) =>
  Effect.sync(() =>
    execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" }).trim().split("\n").sort(),
  );
const unzipEntry = (archive: string, entry: string) =>
  Effect.sync(() => execFileSync("unzip", ["-p", archive, entry], { encoding: "utf8" }));

it.effect("publish sends a validated archive to the Registry", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("readme-authored", root);
    let received: {
      url?: string;
      authorization?: string;
      body?: Schema.Schema.Type<typeof Schema.JsonObject>;
    } = {};
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/.well-known/agent-skills/"))
        return Response.json({ publish: "/registry/{owner}/{slug}/publish" });
      received = {
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        body: Schema.decodeUnknownSync(Schema.JsonObject)(await new Request(input, init).json()),
      };
      return Response.json(
        {
          release: {
            release_id: "rel_1",
            version: "1.2.3",
            revision_id: "revision-1",
            archive_digest: `sha256:${"a".repeat(64)}`,
            download_path: "/api/skits/test/tools/releases/1.2.3/download",
          },
        },
        { status: 201 },
      );
    };
    const result = yield* publish(root, "1.2.3", "revision-1", {
      fetch: fetcher,
      baseUrl: "https://registry.test",
      token: "test-token",
    });
    expect(result.release.version).toBe("1.2.3");
    expect(result.release.revision_id).toBe("revision-1");
    expect(received.url).toBe("https://registry.test/registry/test/tools/publish");
    expect(received.authorization).toBe("Bearer test-token");
    expect(received.body?.version).toBe("1.2.3");
    expect(received.body?.revision_id).toBe("revision-1");
    const archive = join(root, "uploaded.zip");
    yield* writeBytes(archive, Buffer.from(String(received.body?.archive_base64), "base64"));
    expect(yield* unzipList(archive)).toEqual([
      "README.md",
      "skills/review/SKILL.md",
      "skills/review/agents/openai.yaml",
    ]);
    expect(yield* unzipEntry(archive, "skills/review/SKILL.md")).toBe(
      yield* readText(join(root, "skills", "review", "SKILL.md")),
    );
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish uses skit.remote.json without including it in the Release", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-json-publish-test-");
    yield* makeDir(join(root, "skills", "review"));
    yield* writeText(join(root, "README.md"), "# Human-owned tools documentation\n");
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
      join(root, "skit.remote.json"),
      `${JSON.stringify({
        schema: "skit.remote.v1",
        origin: "https://registry.example",
        namespace: "test",
        skit: "tools",
      })}\n`,
    );
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\ndisable-model-invocation: true\n---\n# Review\n",
    );
    yield* makeDir(join(root, "skills", "review", "agents"));
    yield* writeText(
      join(root, "skills", "review", "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
    );
    let publishUrl = "";
    let archiveBase64 = "";
    yield* publish(root, "1.2.3", "revision-1", {
      baseUrl: "https://registry.example",
      fetch: async (input, init) => {
        if (String(input).includes(".well-known")) return new Response(null, { status: 404 });
        publishUrl = String(input);
        archiveBase64 = (await new Request(input, init).json()).archive_base64;
        return Response.json(
          {
            release: {
              release_id: "rel_json",
              version: "1.2.3",
              revision_id: "revision-1",
              archive_digest: `sha256:${"a".repeat(64)}`,
              download_path: "/api/skits/test/tools/releases/1.2.3/download",
            },
          },
          { status: 201 },
        );
      },
    });
    expect(publishUrl).toBe("https://registry.example/api/skits/test/tools/releases");
    const archive = join(root, "skit-json-uploaded.zip");
    yield* writeBytes(archive, Buffer.from(archiveBase64, "base64"));
    const archivedPaths = yield* unzipList(archive);
    expect(archivedPaths).toContain("skit.json");
    expect(archivedPaths).not.toContain("skit.remote.json");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish lets the Registry select its current Draft when --revision is omitted", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-current-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    let publishedRevision: unknown;
    yield* publish(root, "1.2.3", undefined, {
      baseUrl: "https://registry.test",
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes(".well-known")) return new Response(null, { status: 404 });
        publishedRevision = (await new Request(input, init).json()).revision_id;
        return Response.json(
          {
            release: {
              release_id: "rel_current",
              version: "1.2.3",
              revision_id: "draft_current",
              archive_digest: `sha256:${"a".repeat(64)}`,
              download_path: "/api/skits/test/tools/releases/1.2.3/download",
            },
          },
          { status: 201 },
        );
      },
    });
    expect(publishedRevision).toBeUndefined();
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish rejects a Registry authority mismatch before making a request", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-binding-publish-test-");
    yield* writeRemote(root, "https://registry.example");
    yield* writeText(
      join(root, "skit.json"),
      `${JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review" }],
      })}\n`,
    );
    let requests = 0;
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://other.example",
          fetch: async () => {
            requests++;
            return Response.json({});
          },
        }),
      ),
    ).toMatchObject({ code: "CONFLICT" });
    expect(requests).toBe(0);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish validates before making a request", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-invalid-publish-test-");
    let requests = 0;
    yield* writeText(join(root, "README.md"), "not a SKIT\n");
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          fetch: async () => {
            requests++;
            return Response.json({});
          },
        }),
      ),
    ).toBeInstanceOf(Error);
    expect(requests).toBe(0);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish rejects unbaked invocation policy before any archive exists", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-unbaked-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("readme-authored", root);
    yield* writeText(
      join(root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review code.\n---\n# Review\n",
    );
    let requests = 0;

    expect(
      yield* failure(
        publish(root, "1.2.3", "revision-1", {
          baseUrl: "https://registry.test",
          token: "test-token",
          fetch: async () => {
            requests++;
            return Response.json({});
          },
        }),
      ),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("skit author invocation"),
    });
    expect(requests).toBe(0);
    expect(yield* listDir(root)).not.toContain("release.zip");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish reports non-success responses without accepting their body", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-publish-http-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://registry.test",
          fetch: async () => Response.json({ error: "insufficient_scope" }, { status: 403 }),
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/lacks publication:write/) });

    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://registry.test",
          fetch: async () => Response.json({ error: "forbidden" }, { status: 403 }),
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/not authorized to publish this SKIT/) });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish reports the diagnostics that block publication", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-blocked-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : Response.json(
                  {
                    error: "publish_blocked",
                    diagnostics: [
                      {
                        severity: "warning",
                        code: "REVIEW_RECOMMENDED",
                        message: "this warning must not be presented as a blocker",
                      },
                      {
                        severity: "error",
                        code: "SECURITY_POLICY_BLOCKED",
                        message: "review contains undeclared executable behavior",
                      },
                    ],
                  },
                  { status: 422 },
                ),
        }),
      ),
    ).toMatchObject({
      _tag: "PublicationBlocked",
      code: "VALIDATION_FAILED",
      reason: "assessment",
      message: expect.not.stringContaining("this warning must not be presented as a blocker"),
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish tells the author to sync when local files do not match the Draft", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-unsynced-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", undefined, {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : Response.json({ error: "ARCHIVE_MANIFEST_MISMATCH" }, { status: 400 }),
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining(`skit author sync ${root} --apply`) });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish uses the authored path in sync remediation", () =>
  Effect.gen(function* () {
    const parent = yield* scratch("skit-unsynced-path-test-");
    const root = join(parent, "tools with spaces");
    yield* makeDir(root);
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", undefined, {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : Response.json({ error: "ARCHIVE_MANIFEST_MISMATCH" }, { status: 400 }),
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining(`skit author sync '${root}' --apply`) });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish accepts an older successful response without the selected revision", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-old-response-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* publish(root, "1.0.0", "revision-1", {
        baseUrl: "https://registry.test",
        fetch: async (input) =>
          String(input).includes(".well-known")
            ? new Response(null, { status: 404 })
            : Response.json(
                {
                  release: {
                    release_id: "rel_old",
                    version: "1.0.0",
                    archive_digest: `sha256:${"a".repeat(64)}`,
                    download_path: "/api/skits/test/tools/releases/1.0.0/download",
                  },
                },
                { status: 201 },
              ),
      }),
    ).toMatchObject({ release: { version: "1.0.0" } });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish preserves non-JSON Registry error bodies", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-gateway-publish-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", undefined, {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : new Response("upstream unavailable", { status: 502 }),
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/upstream unavailable/) });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish carries immutable release conflicts as a typed error", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-publish-conflict-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : Response.json({ error: "release_conflict" }, { status: 409 }),
        }),
      ),
    ).toMatchObject({ code: "CONFLICT" });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish preserves a non-JSON conflict as a rejected write", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-publish-text-conflict-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", {
          baseUrl: "https://registry.test",
          fetch: async (input) =>
            String(input).includes(".well-known")
              ? new Response(null, { status: 404 })
              : new Response("conflict", { status: 409 }),
        }),
      ),
    ).toMatchObject({ code: "CONFLICT", message: expect.stringContaining("conflict") });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("publish rejects a successful response that violates the server contract", () =>
  Effect.gen(function* () {
    const root = yield* scratch("skit-publish-contract-test-");
    yield* writeRemote(root);
    yield* copySkitFixtureEffect("authored", root);
    expect(
      yield* failure(
        publish(root, "1.0.0", "revision-1", { fetch: async () => Response.json({ release: {} }) }),
      ),
    ).toBeDefined();
  }).pipe(Effect.provide(skitLayer)),
);
