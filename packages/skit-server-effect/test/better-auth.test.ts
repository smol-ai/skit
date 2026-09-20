import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { vi } from "vitest";
import { makeWebHandler } from "../src/http.js";
import { githubAccountLinkingPolicy } from "../src/auth/better-auth.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";
import { expectedMigrations } from "../src/readiness/migrations.generated.js";
import {
  makeAcquisitionId,
  makeCollectionId,
  makeMachineId,
  makeRetainedCopyId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core/universal/consumer";

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

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS server_bootstrap"),
    sql.unsafe("DROP TABLE IF EXISTS d1_migrations"),
    sql.unsafe("DROP TABLE IF EXISTS personal_access_tokens"),
    sql.unsafe("DROP TABLE IF EXISTS team_memberships"),
    sql.unsafe("DROP TABLE IF EXISTS teams"),
    sql.unsafe("DROP TABLE IF EXISTS library_revisions"),
    sql.unsafe("DROP TABLE IF EXISTS library_snapshots"),
    sql.unsafe("DROP TABLE IF EXISTS libraries"),
    sql.unsafe("DROP TABLE IF EXISTS resource_grants"),
    sql.unsafe("DROP TABLE IF EXISTS releases"),
    sql.unsafe("DROP TABLE IF EXISTS draft_files"),
    sql.unsafe("DROP TABLE IF EXISTS draft_revisions"),
    sql.unsafe("DROP TABLE IF EXISTS drafts"),
    sql.unsafe("DROP TABLE IF EXISTS server_operators"),
    sql.unsafe("DROP TABLE IF EXISTS namespaces"),
    sql.unsafe("DROP TABLE IF EXISTS principals"),
    sql.unsafe("DROP TABLE IF EXISTS verification"),
    sql.unsafe("DROP TABLE IF EXISTS session"),
    sql.unsafe("DROP TABLE IF EXISTS account"),
    sql.unsafe("DROP TABLE IF EXISTS user"),
    sql.unsafe(`CREATE TABLE user (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      username TEXT UNIQUE
    )`),
    sql.unsafe(`CREATE TABLE session (
      id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT,
      userAgent TEXT, userId TEXT NOT NULL,
      authorizationGeneration INTEGER NOT NULL DEFAULT 1
    )`),
    sql.unsafe(`CREATE TABLE account (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, accountId TEXT NOT NULL,
      providerId TEXT NOT NULL, userId TEXT NOT NULL, accessToken TEXT,
      refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE verification (
      id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE principals (
      principal_id TEXT PRIMARY KEY, better_auth_user_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'active', authorization_generation INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE personal_access_tokens (
      token_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL,
      name TEXT NOT NULL, scopes_json TEXT NOT NULL,
      authorization_generation INTEGER NOT NULL, expires_at TEXT,
      revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE teams (
      team_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE team_memberships (
      team_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      role TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, principal_id)
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, permission TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE libraries (
      library_id TEXT PRIMARY KEY, owner_subject_kind TEXT NOT NULL,
      owner_subject_id TEXT NOT NULL, current_revision_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(owner_subject_kind, owner_subject_id)
    )`),
    sql.unsafe(`CREATE TABLE library_revisions (
      revision_id TEXT PRIMARY KEY, library_id TEXT NOT NULL,
      parent_revision_id TEXT, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE library_snapshots (
      library_id TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
      status TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
      r2_key TEXT NOT NULL, created_at TEXT NOT NULL, ready_at TEXT,
      PRIMARY KEY (library_id, snapshot_digest)
    )`),
    sql.unsafe(`CREATE TABLE drafts (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
      current_revision_id TEXT, PRIMARY KEY (owner_slug, skit_slug)
    )`),
    sql.unsafe(`CREATE TABLE draft_revisions (
      revision_id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE draft_files (
      revision_id TEXT NOT NULL, path TEXT NOT NULL,
      PRIMARY KEY (revision_id, path)
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE releases (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL,
      version TEXT NOT NULL, release_id TEXT NOT NULL UNIQUE,
      archive_object_key TEXT NOT NULL UNIQUE, published_at TEXT NOT NULL,
      visibility TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE namespaces (
      namespace_slug TEXT PRIMARY KEY, subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL, created_at TEXT NOT NULL
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE server_operators (
      principal_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE server_bootstrap (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'), claimed_at TEXT NOT NULL,
      claimed_by TEXT NOT NULL
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`),
    ...expectedMigrations.map((name, index) =>
      sql.unsafe("INSERT INTO d1_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        index + 1,
        name,
        "2026-09-11T00:00:00.000Z",
      ]),
    ),
  ]),
);

describe("Better Auth adapter", () => {
  it("trusts only same-email GitHub linking for an unverified bootstrap identity", () => {
    expect(githubAccountLinkingPolicy).toEqual({
      enabled: true,
      trustedProviders: ["github"],
      requireLocalEmailVerified: false,
    });
    expect("allowDifferentEmails" in githubAccountLinkingPolicy).toBe(false);
  });

  it.effect("advertises only configured optional authentication services", () =>
    Effect.gen(function* () {
      const disabled = makeWebHandler(env);
      const enabled = makeWebHandler({
        ...env,
        ACCOUNT_REGISTRATION_MODE: "open",
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
        EMAIL_FROM: "SKIT <noreply@registry.test>",
        EMAIL: { send: () => Promise.resolve({ messageId: "test-message" }) },
      });

      const disabledResponse = yield* webPromise(() =>
        disabled.handler(new Request("https://registry.test/api/ui/config")),
      );
      const enabledResponse = yield* webPromise(() =>
        enabled.handler(new Request("https://registry.test/api/ui/config")),
      );

      expect(yield* webPromise(() => disabledResponse.json())).toEqual({
        github: false,
        email: false,
        registration: false,
      });
      expect(yield* webPromise(() => enabledResponse.json())).toEqual({
        github: true,
        email: true,
        registration: true,
      });
      yield* webPromise(() => disabled.dispose());
      yield* webPromise(() => enabled.dispose());
    }),
  );

  it.effect("rejects partial GitHub OAuth configuration", () =>
    Effect.gen(function* () {
      const invalid = makeWebHandler({ ...env, GITHUB_CLIENT_ID: "github-client" });
      const response = yield* webPromise(() =>
        invalid.handler(new Request("https://registry.test/api/auth/get-session")),
      );

      expect(response.status).toBe(503);
      expect(yield* webPromise(() => response.json())).toEqual({
        error: "configuration_error",
        detail: "GITHUB_CLIENT_SECRET is required with GITHUB_CLIENT_ID",
      });
      yield* webPromise(() => invalid.dispose());
    }),
  );

  it.effect("verifies email before claiming a Registry identity", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const messages: Array<{ readonly to: string; readonly text: string }> = [];
      const emailWeb = makeWebHandler({
        ...env,
        ACCOUNT_REGISTRATION_MODE: "open",
        EMAIL_FROM: "SKIT <noreply@registry.test>",
        EMAIL: {
          send: (message) => {
            if ("to" in message && typeof message.to === "string" && "text" in message)
              messages.push({ to: message.to, text: message.text ?? "" });
            return Promise.resolve({ messageId: "verification-message" });
          },
        },
      });
      const response = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/sign-up/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.94",
            },
            body: JSON.stringify({
              name: "Mail User",
              username: "mail-user",
              email: "mail-user@example.test",
              password: "correct horse battery staple",
            }),
          }),
        ),
      );

      expect(response.status).toBe(200);
      expect(messages[0]?.to).toBe("mail-user@example.test");
      const beforeVerification = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT username, emailVerified FROM user WHERE email = 'mail-user@example.test'`,
      );
      expect(beforeVerification[0]).toEqual({ username: null, emailVerified: 0 });
      const identitiesBeforeVerification = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM principals`,
      );
      expect(identitiesBeforeVerification[0]).toEqual({ count: 0 });

      const blockedSignIn = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/sign-in/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.95",
            },
            body: JSON.stringify({
              email: "mail-user@example.test",
              password: "correct horse battery staple",
            }),
          }),
        ),
      );
      expect(blockedSignIn.status).toBe(403);
      expect(messages).toHaveLength(1);

      const resent = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/send-verification-email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.96",
            },
            body: JSON.stringify({
              email: "mail-user@example.test",
              callbackURL: "https://registry.test",
            }),
          }),
        ),
      );
      expect(resent.status).toBe(200);
      expect(yield* webPromise(() => resent.json())).toEqual({ status: true });
      expect(messages).toHaveLength(2);

      const unknownResend = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/send-verification-email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.98",
            },
            body: JSON.stringify({
              email: "unknown@example.test",
              callbackURL: "https://registry.test",
            }),
          }),
        ),
      );
      expect(unknownResend.status).toBe(200);
      expect(yield* webPromise(() => unknownResend.json())).toEqual({ status: true });
      expect(messages).toHaveLength(2);

      const verificationUrl = messages[1]?.text.match(/https:\/\/\S+/)?.[0];
      expect(verificationUrl).toBeDefined();
      const verified = yield* webPromise(() =>
        emailWeb.handler(new Request(verificationUrl!, { redirect: "manual" })),
      );
      expect(verified.status).toBe(302);
      const cookie = (verified.headers.get("set-cookie") ?? "").split(";", 1)[0];
      expect(cookie).toContain("skit-auth.session_token=");

      const replayed = yield* webPromise(() =>
        emailWeb.handler(new Request(verificationUrl!, { redirect: "manual" })),
      );
      expect(replayed.status).toBe(302);
      const identitiesAfterReplay = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM principals`,
      );
      expect(identitiesAfterReplay[0]).toEqual({ count: 0 });

      const claimed = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/onboarding/username", {
            method: "POST",
            headers: {
              cookie,
              origin: "https://registry.test",
              "content-type": "application/json",
            },
            body: JSON.stringify({ username: "Mail-User" }),
          }),
        ),
      );
      expect(claimed.status).toBe(201);
      const identity = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT u.username, u.emailVerified, n.namespace_slug
              FROM user u
              JOIN principals p ON p.better_auth_user_id = u.id
              JOIN namespaces n ON n.subject_id = p.principal_id
              WHERE u.email = 'mail-user@example.test'`,
      );
      expect(identity[0]).toEqual({
        username: "mail-user",
        emailVerified: 1,
        namespace_slug: "mail-user",
      });
      yield* webPromise(() => emailWeb.dispose());
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("rejects an expired email verification link", () =>
    Effect.gen(function* () {
      yield* Effect.sync(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
      });
      yield* prepareDatabase;
      let verificationUrl = "";
      const emailWeb = makeWebHandler({
        ...env,
        ACCOUNT_REGISTRATION_MODE: "open",
        EMAIL_FROM: "noreply@registry.test",
        EMAIL: {
          send: (message) => {
            if ("text" in message)
              verificationUrl = message.text?.match(/https:\/\/\S+/)?.[0] ?? "";
            return Promise.resolve({ messageId: "expiring-verification" });
          },
        },
      });
      const response = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/sign-up/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.97",
            },
            body: JSON.stringify({
              name: "expiring@example.test",
              email: "expiring@example.test",
              password: "correct horse battery staple",
            }),
          }),
        ),
      );
      expect(response.status).toBe(200);
      expect(verificationUrl).not.toBe("");

      yield* Effect.sync(() => vi.setSystemTime(new Date("2026-09-18T02:00:00Z")));
      const expired = yield* webPromise(() =>
        emailWeb.handler(new Request(verificationUrl, { redirect: "manual" })),
      );
      expect(expired.status).toBe(302);
      expect(expired.headers.get("location")).toContain("error=TOKEN_EXPIRED");
      const identity = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT emailVerified, username FROM user WHERE email = 'expiring@example.test'`,
      );
      expect(identity[0]).toEqual({ emailVerified: 0, username: null });
      yield* webPromise(() => emailWeb.dispose());
    }).pipe(Effect.ensuring(Effect.sync(() => vi.useRealTimers())), Effect.provide(bindingsLayer)),
  );

  it.effect("rate limits unauthenticated verification resends", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const emailWeb = makeWebHandler({
        ...env,
        EMAIL_FROM: "noreply@registry.test",
        EMAIL: { send: () => Promise.resolve({ messageId: "unused" }) },
      });
      const responses: Array<Response> = [];
      for (let attempt = 0; attempt < 6; attempt += 1)
        responses.push(
          yield* webPromise(() =>
            emailWeb.handler(
              new Request("https://registry.test/api/auth/send-verification-email", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: "https://registry.test",
                  "cf-connecting-ip": "192.0.2.200",
                },
                body: JSON.stringify({
                  email: "unknown@example.test",
                  callbackURL: "https://registry.test",
                }),
              }),
            ),
          ),
        );
      expect(responses.slice(0, 5).map(({ status }) => status)).toEqual([200, 200, 200, 200, 200]);
      expect(responses[5]?.status).toBe(429);
      expect(responses[5]?.headers.get("retry-after")).toBe("60");
      yield* webPromise(() => emailWeb.dispose());
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("starts GitHub OAuth when the provider is configured", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const github = makeWebHandler({
        ...env,
        GITHUB_CLIENT_ID: "github-client",
        GITHUB_CLIENT_SECRET: "github-secret",
      });
      const response = yield* webPromise(() =>
        github.handler(
          new Request("https://registry.test/api/auth/sign-in/social", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://registry.test" },
            body: JSON.stringify({ provider: "github", callbackURL: "https://registry.test" }),
          }),
        ),
      );
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ url: Schema.String, redirect: Schema.Boolean }),
      )(yield* webPromise(() => response.json()));

      expect(response.status).toBe(200);
      expect(body.redirect).toBe(true);
      expect(body.url).toContain("github.com/login/oauth/authorize");
      expect(body.url).toContain("client_id=github-client");
      yield* webPromise(() => github.dispose());
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("emails the initial operator and blocks password sign-in until verification", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const recipients: Array<string> = [];
      const emailWeb = makeWebHandler({
        ...env,
        EMAIL_FROM: "noreply@registry.test",
        EMAIL: {
          send: (message) => {
            if ("to" in message && typeof message.to === "string") recipients.push(message.to);
            return Promise.resolve({ messageId: "bootstrap-verification" });
          },
        },
      });
      const bootstrap = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/bootstrap", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.89",
            },
            body: JSON.stringify({
              token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
              username: "operator",
              email: "operator@example.test",
              password: "correct horse battery staple",
            }),
          }),
        ),
      );
      expect(bootstrap.status).toBe(201);
      expect(yield* webPromise(() => bootstrap.json())).toMatchObject({
        verificationEmailSent: true,
      });
      expect(recipients).toEqual(["operator@example.test"]);

      const signIn = yield* webPromise(() =>
        emailWeb.handler(
          new Request("https://registry.test/api/auth/sign-in/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.88",
            },
            body: JSON.stringify({
              email: "operator@example.test",
              password: "correct horse battery staple",
            }),
          }),
        ),
      );
      expect(signIn.status).toBe(403);
      yield* webPromise(() => emailWeb.dispose());
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("reports bootstrap email failure without rearming the claim", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const emailWeb = makeWebHandler({
        ...env,
        EMAIL_FROM: "noreply@registry.test",
        EMAIL: { send: () => Promise.reject(new Error("delivery unavailable")) },
      });
      const create = () =>
        emailWeb.handler(
          new Request("https://registry.test/api/bootstrap", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.87",
            },
            body: JSON.stringify({
              token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
              username: "operator",
              email: "operator@example.test",
              password: "correct horse battery staple",
            }),
          }),
        );
      const first = yield* webPromise(create);
      expect(first.status).toBe(201);
      expect(yield* webPromise(() => first.json())).toMatchObject({
        verificationEmailSent: false,
      });
      const replay = yield* webPromise(create);
      expect(replay.status).toBe(409);
      yield* webPromise(() => emailWeb.dispose());
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("signs in the bootstrapped operator with a host-only secure session", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const bootstrap = yield* request("/api/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.90",
        },
        body: JSON.stringify({
          token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
          username: "operator",
          email: "operator@example.test",
          password: "correct horse battery staple",
        }),
      });
      expect(bootstrap.status).toBe(201);

      const signIn = yield* request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.91",
        },
        body: JSON.stringify({
          email: "operator@example.test",
          password: "correct horse battery staple",
        }),
      });

      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("skit-auth.session_token=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Domain=");

      const session = yield* request("/api/auth/get-session", {
        headers: { cookie: cookie.split(";", 1)[0] },
      });
      expect(session.status).toBe(200);
      expect(yield* webPromise(() => session.json())).toMatchObject({
        user: { email: "operator@example.test", username: "operator" },
        session: { authorizationGeneration: 1 },
      });
      const readiness = yield* request("/api/operator/readiness", {
        headers: { cookie: cookie.split(";", 1)[0] },
      });
      expect(readiness.status).toBe(200);
      expect(yield* webPromise(() => readiness.json())).toMatchObject({
        schema: "skit.server.readiness.v1",
        ready: true,
        checks: expect.arrayContaining([
          {
            name: "migrations",
            status: "ok",
            detail: `Applied ${expectedMigrations.length} expected migrations`,
          },
          { name: "bootstrap", status: "ok", detail: "Initial operator exists" },
          { name: "email", status: "ok", detail: "Email verification is disabled" },
        ]),
      });

      const sessionCookie = cookie.split(";", 1)[0];
      const createdToken = yield* request("/api/tokens", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          origin: "https://registry.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "operator laptop", scopes: ["library:sync"] }),
      });
      expect(createdToken.status).toBe(201);
      const token = yield* webPromise(() => createdToken.json());
      expect(token).toMatchObject({
        token_prefix: expect.stringMatching(/^skit_pat_/),
        scopes: ["library:sync"],
        expires_at: null,
      });
      const tokenValue = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(
        token,
      ).token;
      expect(
        (yield* request("/api/operator/readiness", {
          headers: { authorization: `Bearer ${tokenValue}` },
        })).status,
      ).toBe(403);

      const listedTokens = yield* request("/api/tokens", {
        headers: { cookie: sessionCookie },
      });
      expect(listedTokens.status).toBe(200);
      expect(yield* webPromise(() => listedTokens.json())).toMatchObject({
        tokens: [
          {
            name: "operator laptop",
            scopes: ["library:sync"],
            revoked_at: null,
          },
        ],
      });

      const tokenId = Schema.decodeUnknownSync(Schema.Struct({ token_id: Schema.String }))(
        token,
      ).token_id;
      const revokedToken = yield* request(`/api/tokens/${tokenId}`, {
        method: "DELETE",
        headers: { cookie: sessionCookie, origin: "https://registry.test" },
      });
      expect(revokedToken.status).toBe(204);

      expect((yield* request("/api/library", { headers: { cookie: sessionCookie } })).status).toBe(
        404,
      );
      const manifest = { schema: "skit.library.v2", entries: [], bindings: [] };
      const createdLibrary = yield* request("/api/library", {
        method: "PUT",
        headers: {
          cookie: sessionCookie,
          origin: "https://registry.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expected_revision_id: null, manifest }),
      });
      expect(createdLibrary.status).toBe(200);
      const libraryBody = Schema.decodeUnknownSync(
        Schema.Struct({
          library: Schema.Struct({
            library_id: Schema.String,
            revision_id: Schema.String,
            manifest: Schema.Unknown,
          }),
        }),
      )(yield* webPromise(() => createdLibrary.json()));
      expect(libraryBody.library.manifest).toEqual(manifest);
      expect(
        (yield* request("/api/library", {
          method: "PUT",
          headers: {
            cookie: sessionCookie,
            origin: "https://registry.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ expected_revision_id: null, manifest }),
        })).status,
      ).toBe(409);
      const defaultLibrary = yield* request("/api/library", {
        headers: { cookie: sessionCookie },
      });
      const sharedLibrary = yield* request(`/api/libraries/${libraryBody.library.library_id}`, {
        headers: { cookie: sessionCookie },
      });
      expect(defaultLibrary.status).toBe(200);
      expect(sharedLibrary.status).toBe(200);
      expect(yield* webPromise(() => sharedLibrary.json())).toEqual(libraryBody);

      const archive = {
        profile: "verbatim/v1",
        digest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        entries: [],
      };
      const uploadSnapshot = () =>
        request("/api/library/snapshots", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            origin: "https://registry.test",
            "content-type": "application/json",
          },
          body: JSON.stringify(archive),
        });
      const firstUpload = yield* uploadSnapshot();
      expect(firstUpload.status).toBe(200);
      expect(yield* webPromise(() => firstUpload.json())).toMatchObject({
        library_id: libraryBody.library.library_id,
        snapshot_digest: archive.digest,
        reused: false,
      });
      const secondUpload = yield* uploadSnapshot();
      expect(secondUpload.status).toBe(200);
      expect(yield* webPromise(() => secondUpload.json())).toMatchObject({ reused: true });
      const downloaded = yield* request(
        `/api/libraries/${libraryBody.library.library_id}/snapshots/${encodeURIComponent(archive.digest)}`,
        { headers: { cookie: sessionCookie } },
      );
      expect(downloaded.status).toBe(200);
      expect(yield* webPromise(() => downloaded.json())).toEqual(archive);
      const collectionId = makeCollectionId();
      const skillId = makeSkillId();
      const skillVersionId = makeSkillVersionId();
      const retainedCopyId = makeRetainedCopyId();
      const acquisitionId = makeAcquisitionId();
      const machineId = makeMachineId();
      const portable = {
        schema: "skit.library.v5",
        collections: [
          {
            collection_id: collectionId,
            label: "test/library",
            upstream: {
              source_identity: {
                kind: "registry",
                authority: "registry.test",
                namespace: "test",
                slug: "library",
              },
              tracking: { kind: "default" },
              selection: { kind: "full-tree" },
              last_acquisition_id: acquisitionId,
            },
          },
        ],
        skills: [
          {
            skill_id: skillId,
            collection_id: collectionId,
            path: ".",
            name: "library",
            selected_skill_version_id: skillVersionId,
            versions: [
              {
                skill_version_id: skillVersionId,
                source_digest: archive.digest,
                artifact_digest: archive.digest,
                validation_identity_digest: archive.digest,
                materialization_profile: "plain-skill/v1",
                origins: [{ acquisition_id: acquisitionId, source_path: "." }],
              },
            ],
          },
        ],
        retained_copies: [
          {
            retained_copy_id: retainedCopyId,
            digest: archive.digest,
            copy_profile: "verbatim/v1",
            members: [
              {
                source_path: ".",
                source_digest: archive.digest,
                artifact_digest: archive.digest,
                materialization_profile: "plain-skill/v1",
              },
            ],
          },
        ],
        acquisitions: [
          {
            acquisition_id: acquisitionId,
            retained_copy_id: retainedCopyId,
            input: { value: "private:test/library" },
            source_identity: {
              kind: "registry",
              authority: "registry.test",
              namespace: "test",
              slug: "library",
            },
            tracking: { kind: "default" },
            selection: { kind: "selected-paths", paths: ["skills/review"] },
            acquired_at: "2026-01-01T00:00:00.000Z",
            machine_id: machineId,
            observations: [],
          },
        ],
        snapshot_digests: [archive.digest],
        bindings: [],
      };
      const writeLibrarySync = (expected: string | null, manifest: unknown) =>
        request("/api/library/portable", {
          method: "PUT",
          headers: {
            cookie: sessionCookie,
            origin: "https://registry.test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ expected_revision_id: expected, manifest }),
        });
      const committed = yield* writeLibrarySync(libraryBody.library.revision_id, portable);
      expect(committed.status).toBe(200);
      const syncedBody = Schema.decodeUnknownSync(
        Schema.Struct({
          library: Schema.Struct({
            library_id: Schema.String,
            revision_id: Schema.String,
            manifest: Schema.Unknown,
          }),
        }),
      )(yield* webPromise(() => committed.json()));
      const repeated = yield* writeLibrarySync(syncedBody.library.revision_id, portable);
      expect(repeated.status).toBe(200);
      expect(yield* webPromise(() => repeated.json())).toEqual(syncedBody);
      expect(
        (yield* request("/api/library/portable", { headers: { cookie: sessionCookie } })).status,
      ).toBe(200);
      const missingDigest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const sourceBacked = {
        ...portable,
        retained_copies: [
          {
            ...portable.retained_copies[0],
            digest: missingDigest,
            members: [
              {
                ...portable.retained_copies[0].members[0],
                source_digest: missingDigest,
                artifact_digest: missingDigest,
              },
            ],
          },
        ],
        skills: [
          {
            ...portable.skills[0],
            versions: [
              {
                ...portable.skills[0].versions[0],
                source_digest: missingDigest,
                artifact_digest: missingDigest,
                validation_identity_digest: missingDigest,
              },
            ],
          },
        ],
        acquisitions: [
          {
            ...portable.acquisitions[0],
            source_identity: {
              kind: "github",
              owner: "example-org",
              repository: "skills",
              collection_root: ".",
            },
            tracking: { kind: "commit", ref: "e0219e96214ac420bdb8d15141340625fda63bbb" },
            input: { value: "https://github.com/example-org/skills" },
            source_revision: "e0219e96214ac420bdb8d15141340625fda63bbb",
          },
        ],
        snapshot_digests: [],
      };
      const sourceCommitted = yield* writeLibrarySync(syncedBody.library.revision_id, sourceBacked);
      expect(sourceCommitted.status).toBe(200);
      const sourceBody = Schema.decodeUnknownSync(
        Schema.Struct({ library: Schema.Struct({ revision_id: Schema.String }) }),
      )(yield* webPromise(() => sourceCommitted.json()));
      expect(
        (yield* writeLibrarySync(sourceBody.library.revision_id, {
          ...portable,
          retained_copies: [
            {
              ...portable.retained_copies[0],
              digest: missingDigest,
            },
          ],
          snapshot_digests: [missingDigest],
        })).status,
      ).toBe(400);

      const legacyRevisionId = "library_revision_v4_fixture";
      const legacyManifest = {
        ...portable,
        schema: "skit.library.v4",
        collections: portable.collections.map(({ label, ...collection }) => ({
          ...collection,
          display_name: label,
        })),
        skills: portable.skills.map((skill) => ({ ...skill, upstream_path: skill.path })),
      };
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO library_revisions
                (revision_id, library_id, parent_revision_id, manifest_json, created_at)
              VALUES (${legacyRevisionId}, ${libraryBody.library.library_id}, ${sourceBody.library.revision_id}, ${JSON.stringify(legacyManifest)}, '2026-01-02T00:00:00.000Z')`,
          sql`UPDATE libraries SET current_revision_id = ${legacyRevisionId}
              WHERE library_id = ${libraryBody.library.library_id}`,
        ]),
      );
      const legacyRead = yield* request("/api/library/portable", {
        headers: { cookie: sessionCookie },
      });
      expect(legacyRead.status).toBe(200);
      expect(yield* webPromise(() => legacyRead.json())).toMatchObject({
        library: { revision_id: legacyRevisionId, manifest: { schema: "skit.library.v5" } },
      });

      yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`INSERT INTO drafts VALUES ('operator', 'tools', 'private', 'revision_tools')`,
      );
      const authorInventory = yield* request("/api/author/skits", {
        headers: { cookie: sessionCookie },
      });
      expect(authorInventory.status).toBe(200);
      expect(yield* webPromise(() => authorInventory.json())).toEqual({
        skits: [
          {
            skit_id: "operator/tools",
            visibility: "private",
            draft_revision_id: "revision_tools",
            most_recent_release_version: null,
          },
        ],
        next_cursor: null,
      });
      const previewDelete = yield* request("/api/skits/operator/tools?dry_run=true", {
        method: "DELETE",
        headers: { cookie: sessionCookie, origin: "https://registry.test" },
      });
      expect(previewDelete.status).toBe(200);
      expect(yield* webPromise(() => previewDelete.json())).toMatchObject({
        status: "delete_ready",
        skit_id: "operator/tools",
        changed: false,
      });
      expect(
        (yield* request("/api/skits/operator/tools?dry_run=false", {
          method: "DELETE",
          headers: { cookie: sessionCookie, origin: "https://registry.test" },
        })).status,
      ).toBe(400);
      const deletedSkit = yield* request("/api/skits/operator/tools", {
        method: "DELETE",
        headers: { cookie: sessionCookie, origin: "https://registry.test" },
      });
      expect(deletedSkit.status).toBe(200);
      expect(yield* webPromise(() => deletedSkit.json())).toMatchObject({
        status: "deleted",
        skit_id: "operator/tools",
        changed: true,
      });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("lets an authenticated user atomically claim a Registry username", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const bootstrap = yield* request("/api/bootstrap", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.92",
        },
        body: JSON.stringify({
          token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
          username: "temporary",
          email: "oauth-user@example.test",
          password: "correct horse battery staple",
        }),
      });
      expect(bootstrap.status).toBe(201);
      const signIn = yield* request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.93",
        },
        body: JSON.stringify({
          email: "oauth-user@example.test",
          password: "correct horse battery staple",
        }),
      });
      const cookie = (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0];
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("DELETE FROM server_bootstrap"),
          sql.unsafe("DELETE FROM server_operators"),
          sql.unsafe("DELETE FROM namespaces WHERE namespace_slug = 'temporary'"),
          sql.unsafe("DELETE FROM principals"),
          sql.unsafe("UPDATE user SET username = NULL, name = 'octocat' WHERE email = ?", [
            "oauth-user@example.test",
          ]),
        ]),
      );

      const claimed = yield* request("/api/onboarding/username", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://registry.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "OctoCat" }),
      });

      expect(claimed.status).toBe(201);
      expect(yield* webPromise(() => claimed.json())).toEqual({ username: "octocat" });
      const namespace = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT namespace_slug FROM namespaces WHERE namespace_slug = 'octocat'`,
      );
      expect(namespace[0]).toEqual({ namespace_slug: "octocat" });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("keeps account registration closed by default", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* request("/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.92",
        },
        body: JSON.stringify({
          name: "Closed",
          username: "closed",
          email: "closed@example.test",
          password: "password1234",
        }),
      });

      expect(response.status).toBe(400);
      const users = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM user`,
      );
      expect(users[0]).toEqual({ count: 0 });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("provisions a principal and namespace when registration is open", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const openWeb = makeWebHandler({
        ...env,
        ACCOUNT_REGISTRATION_MODE: "open",
        PUBLIC_APP_ORIGIN: "https://registry.test",
        BETTER_AUTH_SECRET: "skit-worker-test-secret-that-is-at-least-thirty-two-characters",
        SKIT_BOOTSTRAP_SECRET: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
      });
      const response = yield* webPromise(() =>
        openWeb.handler(
          new Request("https://registry.test/api/auth/sign-up/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.95",
            },
            body: JSON.stringify({
              name: "New Author",
              username: "New-Author",
              email: "author@example.test",
              password: "password1234",
            }),
          }),
        ),
      );

      expect(response.status).toBe(200);
      const identities = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT u.username, n.namespace_slug, n.subject_kind
               FROM user u
               JOIN principals p ON p.better_auth_user_id = u.id
               JOIN namespaces n ON n.subject_id = p.principal_id
               WHERE u.email = 'author@example.test'`,
      );
      expect(identities[0]).toEqual({
        username: "new-author",
        namespace_slug: "new-author",
        subject_kind: "principal",
      });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("creates a team and manages member lifecycle through a session", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      expect(
        (yield* request("/api/bootstrap", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://registry.test",
            "cf-connecting-ip": "192.0.2.93",
          },
          body: JSON.stringify({
            token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
            username: "operator",
            email: "operator@example.test",
            password: "correct horse battery staple",
          }),
        })).status,
      ).toBe(201);
      const signIn = yield* request("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://registry.test",
          "cf-connecting-ip": "192.0.2.94",
        },
        body: JSON.stringify({
          email: "operator@example.test",
          password: "correct horse battery staple",
        }),
      });
      const cookie = (signIn.headers.get("set-cookie") ?? "").split(";", 1)[0];
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe(
            `INSERT INTO user
             (id, name, email, emailVerified, createdAt, updatedAt, username)
             VALUES ('user_member', 'Member', 'member@example.test', 0, 1, 1, 'member')`,
          ),
          sql.unsafe(
            `INSERT INTO principals
             (principal_id, better_auth_user_id, created_at, updated_at)
             VALUES ('principal_member', 'user_member', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z')`,
          ),
        ]),
      );
      const sessionHeaders = {
        cookie,
        origin: "https://registry.test",
        "content-type": "application/json",
      };

      const created = yield* request("/api/teams", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ slug: "Tool-Makers", name: " Tool Makers " }),
      });
      expect(created.status).toBe(201);
      expect(yield* webPromise(() => created.json())).toMatchObject({
        team: { slug: "tool-makers", name: "Tool Makers" },
      });
      expect(
        (yield* request("/api/teams", {
          method: "POST",
          headers: sessionHeaders,
          body: JSON.stringify({ slug: "tool-makers", name: "Duplicate" }),
        })).status,
      ).toBe(409);

      const added = yield* request("/api/teams/tool-makers/members", {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ email: "MEMBER@example.test" }),
      });
      expect(added.status).toBe(201);
      expect(yield* webPromise(() => added.json())).toEqual({
        member: { principal_id: "principal_member", role: "member" },
      });

      const removed = yield* request("/api/teams/tool-makers/members/principal_member", {
        method: "DELETE",
        headers: sessionHeaders,
      });
      expect(removed.status).toBe(204);
      expect(
        (yield* request("/api/teams/tool-makers/members/principal_member", {
          method: "DELETE",
          headers: sessionHeaders,
        })).status,
      ).toBe(404);
    }).pipe(Effect.provide(bindingsLayer)),
  );
});
