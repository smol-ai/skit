import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Authentication, layer as authenticationLayer } from "../src/auth/authentication.js";
import { BetterAuth, type BetterAuthService } from "../src/auth/better-auth.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const bindingsLayer = Layer.merge(Layer.succeed(Bindings, bindings), databaseLayer(env.DB));
const testLayer = Layer.merge(bindingsLayer, BrowserCrypto.layer);
const betterAuthTestLayer = (
  getSession: BetterAuthService["getSession"] = () => Effect.succeed(undefined),
) =>
  Layer.succeed(
    BetterAuth,
    BetterAuth.of({
      getSession,
      handle: () => Effect.die(new Error("BetterAuth.handle is outside this test surface")),
      claimUsername: () =>
        Effect.die(new Error("BetterAuth.claimUsername is outside this test surface")),
      sendVerificationEmail: () =>
        Effect.die(new Error("BetterAuth.sendVerificationEmail is outside this test surface")),
    }),
  );
const allScopes = new Set(["library:sync", "authoring:write", "publication:write"] as const);
const authenticationServiceFor = (
  supportedScopes = allScopes,
  getSession?: BetterAuthService["getSession"],
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(new Date("2026-09-11T03:04:05.000Z").getTime());
    return yield* Authentication;
  }).pipe(
    Effect.provide(authenticationLayer(supportedScopes)),
    Effect.provide(betterAuthTestLayer(getSession)),
  );
const authenticationService = authenticationServiceFor();

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
    sql`DROP TABLE IF EXISTS personal_access_tokens`,
    sql`DROP TABLE IF EXISTS principals`,
    sql`CREATE TABLE principals (
      principal_id TEXT PRIMARY KEY, better_auth_user_id TEXT UNIQUE, state TEXT NOT NULL,
      authorization_generation INTEGER NOT NULL
    )`,
    sql`CREATE TABLE personal_access_tokens (
      token_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
      scopes_json TEXT NOT NULL, authorization_generation INTEGER NOT NULL,
      expires_at TEXT, revoked_at TEXT, last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-09-11T00:00:00.000Z'
    )`,
  ]),
);

describe("personal access token authentication", () => {
  it.effect("rejects scopes omitted from the server capability composition", () =>
    Effect.gen(function* () {
      const authentication = yield* authenticationServiceFor(new Set(["library:sync"] as const));
      const failure = yield* Effect.flip(
        authentication.createPat(
          {
            id: "principal_owner",
            credential: "session",
            scopes: new Set(["library:sync"]),
          },
          { name: "unsupported", scopes: ["authoring:write"] },
        ),
      );
      expect(failure._tag).toBe("Authentication.InvalidScope");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("authenticates an active token and records its use", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const service = yield* authenticationService;
      const token = "skit_pat_fixture";
      const tokenHash = yield* sha256(token);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO principals (principal_id, state, authorization_generation)
              VALUES ('principal_test', 'active', 3)`,
          sql`INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation)
               VALUES ('pat_test', 'principal_test', ${tokenHash}, '["library:sync"]', 3)`,
        ]),
      );

      const principal = yield* service.authenticatePat(token);

      expect(principal).toEqual({
        id: "principal_test",
        credential: "personal_access_token",
        scopes: new Set(["library:sync"]),
        tokenId: "pat_test",
      });
      const used = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT last_used_at FROM personal_access_tokens WHERE token_id = 'pat_test'`,
      );
      expect(used[0]?.last_used_at).toBe("2026-09-11T03:04:05.000Z");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("resolves an active session at its authorization generation", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`INSERT INTO principals
             (principal_id, better_auth_user_id, state, authorization_generation)
             VALUES ('principal_session', 'user_session', 'active', 7)`,
      );
      const sessionAuthentication = yield* authenticationServiceFor(allScopes, () =>
        Effect.succeed({ userId: "user_session", authorizationGeneration: 7 }),
      );

      const principal = yield* sessionAuthentication.authenticate(
        new Request("https://registry.test/api/library"),
      );

      expect(principal).toEqual({
        id: "principal_session",
        credential: "session",
        scopes: new Set(["library:sync", "authoring:write", "publication:write"]),
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects malformed, revoked, stale-generation, and expired tokens", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const service = yield* authenticationService;
      const revoked = "skit_pat_revoked";
      const stale = "skit_pat_stale";
      const expired = "skit_pat_expired";
      const [revokedHash, staleHash, expiredHash] = yield* Effect.all([
        sha256(revoked),
        sha256(stale),
        sha256(expired),
      ]);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO principals (principal_id, state, authorization_generation)
              VALUES ('principal_test', 'active', 2)`,
          sql`INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation, revoked_at)
               VALUES ('pat_revoked', 'principal_test', ${revokedHash}, '[]', 2, '2026-09-11T00:00:00.000Z')`,
          sql`INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation)
               VALUES ('pat_stale', 'principal_test', ${staleHash}, '[]', 1)`,
          sql`INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation, expires_at)
               VALUES ('pat_expired', 'principal_test', ${expiredHash}, '[]', 2, '2000-01-01T00:00:00.000Z')`,
        ]),
      );

      expect(yield* service.authenticatePat("other_token")).toBeUndefined();
      expect(yield* service.authenticatePat("skit_pat_missing")).toBeUndefined();
      expect(yield* service.authenticatePat(revoked)).toBeUndefined();
      expect(yield* service.authenticatePat(stale)).toBeUndefined();
      expect(yield* service.authenticatePat(expired)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects persisted scopes outside the protocol", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const service = yield* authenticationService;
      const token = "skit_pat_invalid_scope";
      const tokenHash = yield* sha256(token);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO principals (principal_id, state, authorization_generation)
              VALUES ('principal_test', 'active', 1)`,
          sql`INSERT INTO personal_access_tokens
               (token_id, principal_id, token_hash, scopes_json, authorization_generation)
               VALUES ('pat_test', 'principal_test', ${tokenHash}, '["root"]', 1)`,
        ]),
      );

      const failure = yield* Effect.flip(service.authenticatePat(token));
      expect(failure).toMatchObject({
        _tag: "Cloudflare.DatabaseError",
        operation: "decode access token scopes",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("creates, lists, and revokes scoped personal access tokens", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const authentication = yield* authenticationService;
      yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`INSERT INTO principals (principal_id, state, authorization_generation)
              VALUES ('principal_owner', 'active', 4)`,
      );
      const session = {
        id: "principal_owner",
        credential: "session" as const,
        scopes: new Set(["library:sync" as const]),
      };

      const created = yield* authentication.createPat(session, {
        name: "sync laptop",
        scopes: ["library:sync", "authoring:write"],
        expiresAt: "2030-01-01T00:00:00Z",
      });

      expect(created.token).toMatch(/^skit_pat_[A-Za-z0-9_-]{43}$/);
      expect(created.token_id).toMatch(/^pat_[a-f0-9]{32}$/);
      expect(created.token_prefix).toBe(created.token.slice(0, 18));
      expect(created.expires_at).toBe("2030-01-01T00:00:00.000Z");
      expect(yield* authentication.authenticatePat(created.token)).toMatchObject({
        id: "principal_owner",
        tokenId: created.token_id,
      });

      const listed = yield* authentication.listPats(session);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        token_id: created.token_id,
        token_prefix: created.token_prefix,
        name: "sync laptop",
        scopes: ["library:sync", "authoring:write"],
        expires_at: "2030-01-01T00:00:00.000Z",
        revoked_at: null,
      });

      expect(yield* authentication.revokePat(session, created.token_id)).toBe(true);
      expect(yield* authentication.revokePat(session, created.token_id)).toBe(false);
      expect(yield* authentication.authenticatePat(created.token)).toBeUndefined();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("requires a session to mint and list tokens", () =>
    Effect.gen(function* () {
      const authentication = yield* authenticationService;
      const pat = {
        id: "principal_owner",
        credential: "personal_access_token" as const,
        scopes: new Set(["library:sync" as const]),
        tokenId: "pat_self",
      };
      const createFailure = yield* Effect.flip(
        authentication.createPat(pat, { name: "nope", scopes: ["library:sync"] }),
      );
      const listFailure = yield* Effect.flip(authentication.listPats(pat));

      expect(createFailure._tag).toBe("Authentication.SessionRequired");
      expect(listFailure._tag).toBe("Authentication.SessionRequired");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects scopes not composed into this server edition", () =>
    Effect.gen(function* () {
      const authentication = yield* authenticationServiceFor(new Set(["library:sync"]));
      const session = {
        id: "principal_owner",
        credential: "session" as const,
        scopes: new Set(["library:sync" as const]),
      };

      const failure = yield* Effect.flip(
        authentication.createPat(session, { name: "author", scopes: ["authoring:write"] }),
      );

      expect(failure._tag).toBe("Authentication.InvalidScope");
    }).pipe(Effect.provide(testLayer)),
  );
});
