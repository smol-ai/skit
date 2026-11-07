import { applyD1Migrations, env, reset } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";
import { makeWebHandler } from "../src/http.js";
import { BlobStore, blobStoreLayer, databaseLayer } from "../src/platform/cloudflare.js";

const platformLayer = Layer.merge(blobStoreLayer(env.SKIT_BLOBS), databaseLayer(env.DB));

let web: ReturnType<typeof makeWebHandler>;

const webPromise = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test helper owns that host boundary.
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.orDie);

const request = (path: string, init?: RequestInit) =>
  webPromise(() => web.handler(new Request(`https://registry.test${path}`, init)));

const responseText = (response: Response) =>
  webPromise(() => response.arrayBuffer()).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

const sha256 = (value: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Web Crypto is Promise-only; this fixture helper owns the host boundary.
  Effect.tryPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.orDie,
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Obsolete grants must never grant access, even if a database still contains them.
  await env.DB.prepare(`CREATE TABLE resource_grants (
    grant_id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
    resource_kind TEXT, resource_id TEXT, permission TEXT
  )`).run();
  web = makeWebHandler(env);
});

afterEach(() => web.dispose());

const insertRelease = (input: {
  version: string;
  releaseId: string;
  objectKey: string;
  publishedAt: string;
  visibility: "public" | "unlisted" | "private";
}) =>
  Effect.flatMap(D1Client.D1Client, (sql) =>
    sql.unsafe(
      `INSERT INTO releases
         (owner_slug, skit_slug, version, release_id, archive_object_key, published_at, visibility, archive_digest, archive_bytes)
         VALUES ('tim', 'tools', ?, ?, ?, ?, ?, 'fixture-digest', 0)`,
      [input.version, input.releaseId, input.objectKey, input.publishedAt, input.visibility],
    ),
  );

describe("anonymous Release downloads", () => {
  it.effect("returns 404 for an empty latest lookup without consulting credentials", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(D1Client.D1Client, (sql) => sql`DROP TABLE personal_access_tokens`);
      const response = yield* request("/api/skits/tim/tools/releases/latest/download", {
        headers: { authorization: "Bearer skit_pat_missing" },
      });
      expect(response.status).toBe(404);
      expect(yield* webPromise(() => response.json())).toEqual({ error: "release_not_found" });
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("serves an exact public Release as immutable", () =>
    Effect.gen(function* () {
      yield* insertRelease({
        version: "1.0.0",
        releaseId: "rel_public",
        objectKey: "releases/public.zip",
        publishedAt: "2026-09-11T00:00:00.000Z",
        visibility: "public",
      });
      yield* Effect.flatMap(BlobStore, (blobs) =>
        blobs.put(
          "write release fixture",
          "releases/public.zip",
          new TextEncoder().encode("public archive"),
        ),
      );
      const token = "skit_pat_public_download";
      const tokenHash = yield* sha256(token);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
              VALUES ('user_public', 'Reader', 'public@example.test', 1, 1, 1)`),
          sql.unsafe(`INSERT INTO principals
              (principal_id, better_auth_user_id, state, authorization_generation, created_at, updated_at)
              VALUES ('principal_public', 'user_public', 'active', 1, 'created', 'updated')`),
          sql.unsafe(
            `INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation, token_prefix, name, created_at)
               VALUES ('pat_public', 'principal_public', ?, '[]', 1, 'skit_pat', 'fixture', 'created')`,
            [tokenHash],
          ),
        ]),
      );

      const response = yield* request("/api/skits/tim/tools/releases/1.0.0/download");
      const authenticatedPublicResponse = yield* request(
        "/api/skits/tim/tools/releases/1.0.0/download",
        { headers: { authorization: `Bearer ${token}` } },
      );
      const credential = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT last_used_at FROM personal_access_tokens WHERE token_id = 'pat_public'`,
      );

      expect(response.status).toBe(200);
      expect(authenticatedPublicResponse.status).toBe(200);
      expect(credential[0]).toEqual({ last_used_at: null });
      expect(response.headers.get("skit-release-version")).toBe("1.0.0");
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(yield* responseText(response)).toBe("public archive");
      // Public release reads must not require the authenticated application graph.
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          makeWebHandler({ ...env, PUBLIC_APP_ORIGIN: undefined, BETTER_AUTH_SECRET: undefined }),
        ),
        (anonymous) =>
          Effect.gen(function* () {
            const download = yield* webPromise(() =>
              anonymous.handler(
                new Request("https://registry.test/api/skits/tim/tools/releases/1.0.0/download"),
              ),
            );
            expect(download.status).toBe(200);
            expect(download.headers.get("cache-control")).toBe(
              "public, max-age=31536000, immutable",
            );
            expect(yield* responseText(download)).toBe("public archive");
          }),
        (anonymous) => webPromise(() => anonymous.dispose()),
      );
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("selects the newest anonymously visible Release for latest", () =>
    Effect.gen(function* () {
      yield* insertRelease({
        version: "1.0.0",
        releaseId: "rel_public",
        objectKey: "releases/public-latest.zip",
        publishedAt: "2026-09-11T00:00:00.000Z",
        visibility: "public",
      });
      yield* insertRelease({
        version: "1.1.0",
        releaseId: "rel_unlisted",
        objectKey: "releases/unlisted-latest.zip",
        publishedAt: "2026-09-11T01:00:00.000Z",
        visibility: "unlisted",
      });
      yield* insertRelease({
        version: "2.0.0",
        releaseId: "rel_private",
        objectKey: "releases/private-latest.zip",
        publishedAt: "2026-09-11T02:00:00.000Z",
        visibility: "private",
      });
      yield* Effect.flatMap(BlobStore, (blobs) =>
        blobs.put(
          "write release fixture",
          "releases/unlisted-latest.zip",
          new TextEncoder().encode("unlisted archive"),
        ),
      );

      const response = yield* request("/api/skits/tim/tools/releases/latest/download");

      expect(response.status).toBe(200);
      expect(response.headers.get("skit-release-version")).toBe("1.1.0");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* responseText(response)).toBe("unlisted archive");
      yield* Effect.flatMap(D1Client.D1Client, (sql) => sql`DROP TABLE personal_access_tokens`);
      const fallback = yield* request("/api/skits/tim/tools/releases/latest/download", {
        headers: { authorization: "Bearer skit_pat_broken_storage" },
      });
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("skit-release-version")).toBe("1.1.0");
      expect(yield* responseText(fallback)).toBe("unlisted archive");
      const failedExact = yield* request("/api/skits/tim/tools/releases/2.0.0/download", {
        headers: { authorization: "Bearer skit_pat_broken_storage" },
      });
      expect(failedExact.status).toBe(500);
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("conceals private Releases and distinguishes missing archives", () =>
    Effect.gen(function* () {
      yield* insertRelease({
        version: "1.0.0",
        releaseId: "rel_private",
        objectKey: "releases/private.zip",
        publishedAt: "2026-09-11T00:00:00.000Z",
        visibility: "private",
      });
      yield* insertRelease({
        version: "1.1.0",
        releaseId: "rel_missing_archive",
        objectKey: "releases/missing.zip",
        publishedAt: "2026-09-11T01:00:00.000Z",
        visibility: "public",
      });

      const privateResponse = yield* request("/api/skits/tim/tools/releases/1.0.0/download");
      const missingArchive = yield* request("/api/skits/tim/tools/releases/1.1.0/download");

      expect(privateResponse.status).toBe(404);
      expect(yield* webPromise(() => privateResponse.json())).toEqual({
        error: "release_not_found",
      });
      expect(missingArchive.status).toBe(404);
      expect(yield* webPromise(() => missingArchive.json())).toEqual({
        error: "archive_not_found",
      });
    }).pipe(Effect.provide(platformLayer)),
  );

  it.effect(
    "requires namespace ownership or current team membership for private Releases, never grants",
    () =>
      Effect.gen(function* () {
        const token = "skit_pat_private_download";
        const tokenHash = yield* sha256(token);
        yield* Effect.flatMap(D1Client.D1Client, (sql) =>
          sql.batch([
            sql.unsafe(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
              VALUES ('user_reader', 'Reader', 'reader@example.test', 1, 1, 1)`),
            sql.unsafe(`INSERT INTO principals
              (principal_id, better_auth_user_id, state, authorization_generation, created_at, updated_at)
              VALUES ('principal_reader', 'user_reader', 'active', 1, 'created', 'updated')`),
            sql.unsafe(
              `INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation, token_prefix, name, created_at)
               VALUES ('pat_reader', 'principal_reader', ?, '["authoring:write"]', 1, 'skit_pat', 'fixture', 'created')`,
              [tokenHash],
            ),
            sql.unsafe(
              `INSERT INTO resource_grants VALUES
             ('grant_release', 'principal', 'principal_reader', 'release', 'rel_accessible', 'read')`,
            ),
          ]),
        );
        yield* insertRelease({
          version: "1.0.0",
          releaseId: "rel_accessible",
          objectKey: "releases/private-accessible.zip",
          publishedAt: "2026-09-11T01:00:00.000Z",
          visibility: "private",
        });
        yield* insertRelease({
          version: "2.0.0",
          releaseId: "rel_inaccessible",
          objectKey: "releases/private-inaccessible.zip",
          publishedAt: "2026-09-11T02:00:00.000Z",
          visibility: "private",
        });
        yield* Effect.flatMap(BlobStore, (blobs) =>
          blobs.put(
            "write private release fixture",
            "releases/private-accessible.zip",
            new TextEncoder().encode("private archive"),
          ),
        );

        const blobs = yield* BlobStore;
        yield* blobs.put(
          "write newer private release fixture",
          "releases/private-inaccessible.zip",
          new TextEncoder().encode("newer private archive"),
        );
        const sql = yield* D1Client.D1Client;
        const download = (version: string) =>
          request(`/api/skits/tim/tools/releases/${version}/download`, {
            headers: { authorization: `Bearer ${token}` },
          });
        expect((yield* request("/api/skits/tim/tools/releases/1.0.0/download")).status).toBe(404);
        for (const version of ["1.0.0", "latest"])
          expect((yield* download(version)).status).toBe(404);
        yield* sql`INSERT INTO namespaces VALUES ('tim', 'principal', 'principal_reader', 'created')`;
        for (const [version, selected, content] of [
          ["1.0.0", "1.0.0", "private archive"],
          ["latest", "2.0.0", "newer private archive"],
        ]) {
          const response = yield* download(version);
          expect(response.status).toBe(200);
          expect(response.headers.get("skit-release-version")).toBe(selected);
          expect(response.headers.get("cache-control")).toBe("private, no-store");
          expect(yield* responseText(response)).toBe(content);
        }
        yield* sql.batch([
          sql`UPDATE namespaces SET subject_kind = 'team', subject_id = 'team_owner' WHERE namespace_slug = 'tim'`,
          sql`INSERT INTO teams VALUES ('team_other', 'other', 'Other', 'created'), ('team_owner', 'owner', 'Owner', 'created')`,
          sql`INSERT INTO team_memberships VALUES ('team_other', 'principal_reader', 'member', 'created')`,
        ]);
        for (const version of ["1.0.0", "latest"])
          expect((yield* download(version)).status).toBe(404);
        yield* sql`INSERT INTO team_memberships VALUES ('team_owner', 'principal_reader', 'member', 'created')`;
        for (const version of ["1.0.0", "latest"])
          expect((yield* download(version)).status).toBe(200);
        yield* sql`DROP TABLE resource_grants`;
        expect((yield* download("latest")).status).toBe(200);
        yield* sql`DELETE FROM team_memberships WHERE team_id = 'team_owner' AND principal_id = 'principal_reader'`;
        for (const version of ["1.0.0", "latest"])
          expect((yield* download(version)).status).toBe(404);
      }).pipe(Effect.provide(platformLayer)),
  );

  it.effect("rejects unsupported download methods", () =>
    Effect.gen(function* () {
      for (const method of ["POST", "HEAD"] as const) {
        const response = yield* request("/api/skits/tim/tools/releases/1.0.0/download", {
          method,
        });
        expect(response.status).toBe(405);
        if (method !== "HEAD")
          expect(yield* webPromise(() => response.json())).toEqual({
            error: "method_not_allowed",
          });
      }
    }),
  );
});
