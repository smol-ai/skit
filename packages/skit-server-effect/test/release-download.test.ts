import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeWebHandler } from "../src/http.js";
import { Bindings, blobStorageEffect, databaseLayer } from "../src/platform/cloudflare.js";

const bindingsLayer = Layer.merge(
  Layer.succeed(Bindings, { database: env.DB, blobs: env.SKIT_BLOBS }),
  databaseLayer(env.DB),
);

const web = makeWebHandler(env);

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

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS releases"),
    sql.unsafe("DROP TABLE IF EXISTS resource_grants"),
    sql.unsafe("DROP TABLE IF EXISTS namespaces"),
    sql.unsafe("DROP TABLE IF EXISTS team_memberships"),
    sql.unsafe("DROP TABLE IF EXISTS personal_access_tokens"),
    sql.unsafe("DROP TABLE IF EXISTS principals"),
    sql.unsafe(`CREATE TABLE releases (
      owner_slug TEXT NOT NULL,
      skit_slug TEXT NOT NULL,
      version TEXT NOT NULL,
      release_id TEXT NOT NULL UNIQUE,
      archive_object_key TEXT NOT NULL UNIQUE,
      published_at TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private')),
      PRIMARY KEY (owner_slug, skit_slug, version)
    )`),
    sql.unsafe(`CREATE TABLE principals (
      principal_id TEXT PRIMARY KEY, better_auth_user_id TEXT UNIQUE,
      state TEXT NOT NULL, authorization_generation INTEGER NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE personal_access_tokens (
      token_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, token_hash TEXT NOT NULL,
      scopes_json TEXT NOT NULL, authorization_generation INTEGER NOT NULL,
      expires_at TEXT, revoked_at TEXT, last_used_at TEXT
    )`),
    sql.unsafe(
      "CREATE TABLE team_memberships (team_id TEXT, principal_id TEXT, PRIMARY KEY (team_id, principal_id))",
    ),
    sql.unsafe(
      "CREATE TABLE namespaces (namespace_slug TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT)",
    ),
    sql.unsafe(`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      resource_kind TEXT, resource_id TEXT, permission TEXT
    )`),
  ]),
);

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
         (owner_slug, skit_slug, version, release_id, archive_object_key, published_at, visibility)
         VALUES ('tim', 'tools', ?, ?, ?, ?, ?)`,
      [input.version, input.releaseId, input.objectKey, input.publishedAt, input.visibility],
    ),
  );

describe("anonymous Release downloads", () => {
  it.effect("serves an exact public Release as immutable", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      yield* insertRelease({
        version: "1.0.0",
        releaseId: "rel_public",
        objectKey: "releases/public.zip",
        publishedAt: "2026-09-11T00:00:00.000Z",
        visibility: "public",
      });
      yield* blobStorageEffect("write release fixture", (blobs) =>
        blobs.put("releases/public.zip", "public archive"),
      );
      const token = "skit_pat_public_download";
      const tokenHash = yield* sha256(token);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("INSERT INTO principals VALUES ('principal_public', NULL, 'active', 1)"),
          sql.unsafe(
            `INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation)
               VALUES ('pat_public', 'principal_public', ?, '[]', 1)`,
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
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("selects the newest anonymously visible Release for latest", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
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
      yield* blobStorageEffect("write release fixture", (blobs) =>
        blobs.put("releases/unlisted-latest.zip", "unlisted archive"),
      );

      const response = yield* request("/api/skits/tim/tools/releases/latest/download");

      expect(response.status).toBe(200);
      expect(response.headers.get("skit-release-version")).toBe("1.1.0");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(yield* responseText(response)).toBe("unlisted archive");
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("conceals private Releases and distinguishes missing archives", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
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
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("serves granted private Releases and selects the latest accessible candidate", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const token = "skit_pat_private_download";
      const tokenHash = yield* sha256(token);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("INSERT INTO principals VALUES ('principal_reader', NULL, 'active', 1)"),
          sql.unsafe(
            `INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation)
               VALUES ('pat_reader', 'principal_reader', ?, '["authoring:write"]', 1)`,
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
      yield* blobStorageEffect("write private release fixture", (blobs) =>
        blobs.put("releases/private-accessible.zip", "private archive"),
      );

      const anonymous = yield* request("/api/skits/tim/tools/releases/1.0.0/download");
      const exact = yield* request("/api/skits/tim/tools/releases/1.0.0/download", {
        headers: { authorization: `Bearer ${token}` },
      });
      const latest = yield* request("/api/skits/tim/tools/releases/latest/download", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(anonymous.status).toBe(404);
      for (const response of [exact, latest]) {
        expect(response.status).toBe(200);
        expect(response.headers.get("skit-release-version")).toBe("1.0.0");
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(yield* responseText(response)).toBe("private archive");
      }
    }).pipe(Effect.provide(bindingsLayer)),
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
