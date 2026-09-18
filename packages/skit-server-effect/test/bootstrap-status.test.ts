import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeWebHandler } from "../src/http.js";
import { PasswordHasher, layer as passwordHasherLayer } from "../src/auth/password.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";
import { layer as nativeCryptoLayer } from "../src/platform/native-crypto.js";

const bindingsLayer = Layer.merge(
  Layer.succeed(Bindings, { database: env.DB, blobs: env.SKIT_BLOBS }),
  databaseLayer(env.DB),
);
const testLayer = Layer.merge(
  bindingsLayer,
  passwordHasherLayer.pipe(Layer.provide(nativeCryptoLayer)),
);

const web = makeWebHandler(env);

const webPromise = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Fetch-compatible Worker handlers are Promise APIs; this test helper owns that host boundary.
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(Effect.orDie);

const requestStatus = () =>
  webPromise(() => web.handler(new Request("https://registry.test/api/bootstrap/status")));

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS server_bootstrap"),
    sql.unsafe(`CREATE TABLE server_bootstrap (
      id TEXT PRIMARY KEY CHECK (id = 'singleton'),
      claimed_at TEXT NOT NULL,
      claimed_by TEXT NOT NULL
    ) WITHOUT ROWID`),
  ]),
);

const prepareIdentityDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS server_bootstrap"),
    sql.unsafe("DROP TABLE IF EXISTS server_operators"),
    sql.unsafe("DROP TABLE IF EXISTS namespaces"),
    sql.unsafe("DROP TABLE IF EXISTS principals"),
    sql.unsafe("DROP TABLE IF EXISTS account"),
    sql.unsafe("DROP TABLE IF EXISTS user"),
    sql.unsafe(`CREATE TABLE user (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE account (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, accountId TEXT NOT NULL,
      providerId TEXT NOT NULL, userId TEXT NOT NULL, password TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE principals (
      principal_id TEXT PRIMARY KEY, better_auth_user_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  ]),
);

describe("bootstrap status", () => {
  it.effect("reports that an unclaimed server needs bootstrap", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;

      const response = yield* requestStatus();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(yield* webPromise(() => response.json())).toEqual({ needed: true });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("reports that a claimed server does not need bootstrap", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`INSERT INTO server_bootstrap (id, claimed_at, claimed_by)
              VALUES ('singleton', '2026-09-11T00:00:00.000Z', 'principal_test')`,
      );

      const response = yield* requestStatus();

      expect(response.status).toBe(200);
      expect(yield* webPromise(() => response.json())).toEqual({ needed: false });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("conceals bootstrap without its secret and reports invalid configuration", () =>
    Effect.gen(function* () {
      const base = {
        DB: env.DB,
        SKIT_BLOBS: env.SKIT_BLOBS,
        AUTH_RATE_LIMITER: env.AUTH_RATE_LIMITER,
        PAT_RATE_LIMITER: env.PAT_RATE_LIMITER,
        BOOTSTRAP_RATE_LIMITER: env.BOOTSTRAP_RATE_LIMITER,
        ACCOUNT_REGISTRATION_MODE: env.ACCOUNT_REGISTRATION_MODE,
      };
      const concealed = makeWebHandler({
        ...base,
        PUBLIC_APP_ORIGIN: "https://registry.test",
        BETTER_AUTH_SECRET: "configured-auth-secret",
      });
      const misconfigured = makeWebHandler({
        ...base,
        SKIT_BOOTSTRAP_SECRET: "configured-bootstrap-secret",
        BETTER_AUTH_SECRET: "configured-auth-secret",
      });

      const concealedResponse = yield* webPromise(() =>
        concealed.handler(new Request("https://registry.test/api/bootstrap/status")),
      );
      const configurationResponse = yield* webPromise(() =>
        misconfigured.handler(new Request("https://registry.test/api/bootstrap/status")),
      );

      expect(concealedResponse.status).toBe(404);
      expect(configurationResponse.status).toBe(503);
      expect(yield* webPromise(() => configurationResponse.json())).toEqual({
        error: "configuration_error",
        detail: "PUBLIC_APP_ORIGIN is required",
      });
    }),
  );

  it.effect("isolates invalid authentication configuration from public routes", () =>
    Effect.gen(function* () {
      const invalid = makeWebHandler({
        ...env,
        PUBLIC_APP_ORIGIN: "not a URL",
        BETTER_AUTH_SECRET: "configured-auth-secret",
      });

      const health = yield* webPromise(() =>
        invalid.handler(new Request("https://registry.test/health")),
      );
      const authentication = yield* webPromise(() =>
        invalid.handler(new Request("https://registry.test/api/auth/get-session")),
      );

      expect(health.status).toBe(200);
      expect(authentication.status).toBe(503);
      expect(yield* webPromise(() => authentication.json())).toEqual({
        error: "configuration_error",
        detail: "PUBLIC_APP_ORIGIN must be a valid URL",
      });
      yield* webPromise(() => invalid.dispose());
    }),
  );

  it.effect("reports a rate limiter outage as storage failure", () =>
    Effect.gen(function* () {
      const unavailable = makeWebHandler({
        ...env,
        BOOTSTRAP_RATE_LIMITER: {
          limit: () => Promise.reject(new Error("rate limiter unavailable")),
        },
      });
      const response = yield* webPromise(() =>
        unavailable.handler(
          new Request("https://registry.test/api/bootstrap", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://registry.test",
              "cf-connecting-ip": "192.0.2.99",
            },
            body: "{}",
          }),
        ),
      );

      expect(response.status).toBe(500);
      expect(yield* webPromise(() => response.json())).toEqual({ error: "storage_failure" });
      yield* webPromise(() => unavailable.dispose());
    }),
  );

  it.effect("creates exactly one initial operator with a compatible credential", () =>
    Effect.gen(function* () {
      yield* prepareIdentityDatabase;
      const post = () =>
        webPromise(() =>
          web.handler(
            new Request("https://registry.test/api/bootstrap", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "https://registry.test",
                "cf-connecting-ip": "192.0.2.73",
              },
              body: JSON.stringify({
                token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
                username: "Operator",
                email: "OPERATOR@example.test",
                password: "correct horse battery staple",
              }),
            }),
          ),
        );

      const created = yield* post();
      expect(created.status).toBe(201);
      expect(yield* webPromise(() => created.json())).toEqual({
        email: "operator@example.test",
        username: "operator",
        verificationEmailSent: false,
      });
      expect((yield* post()).status).toBe(409);

      const user = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT name, username, email FROM user`,
      );
      expect(user[0]).toEqual({
        name: "operator",
        username: "operator",
        email: "operator@example.test",
      });
      const account = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql<{ issuer: string; password: string }>`SELECT issuer, password FROM account`,
      );
      expect(account[0]?.issuer).toBe("local:credential");
      expect(
        yield* (yield* PasswordHasher).verify(
          "correct horse battery staple",
          account[0]?.password ?? "",
        ),
      ).toBe(true);
      for (const table of [
        "user",
        "account",
        "principals",
        "namespaces",
        "server_operators",
        "server_bootstrap",
      ]) {
        const count = yield* Effect.flatMap(D1Client.D1Client, (sql) =>
          sql.unsafe(`SELECT COUNT(*) count FROM ${table}`),
        );
        expect(count[0]).toEqual({ count: 1 });
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects malformed input, wrong origins, and wrong secrets", () =>
    Effect.gen(function* () {
      yield* prepareIdentityDatabase;
      const post = (origin: string, body: unknown, ip: string) =>
        webPromise(() =>
          web.handler(
            new Request("https://registry.test/api/bootstrap", {
              method: "POST",
              headers: { "content-type": "application/json", origin, "cf-connecting-ip": ip },
              body: JSON.stringify(body),
            }),
          ),
        );
      const valid = {
        token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
        username: "operator",
        email: "operator@example.test",
        password: "password1234",
      };

      expect((yield* post("https://attacker.test", valid, "192.0.2.74")).status).toBe(403);
      expect(
        (yield* post("https://registry.test", { ...valid, token: "wrong" }, "192.0.2.75")).status,
      ).toBe(401);
      expect(
        (yield* post("https://registry.test", { ...valid, username: "admin" }, "192.0.2.76"))
          .status,
      ).toBe(400);
      expect((yield* post("https://registry.test", { token: "only" }, "192.0.2.77")).status).toBe(
        400,
      );
      const users = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM user`,
      );
      expect(users[0]).toEqual({ count: 0 });
    }).pipe(Effect.provide(bindingsLayer)),
  );

  it.effect("keeps database failures opaque", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(D1Client.D1Client, (sql) => sql`DROP TABLE IF EXISTS server_bootstrap`);

      const response = yield* requestStatus();

      expect(response.status).toBe(500);
      expect(yield* webPromise(() => response.json())).toEqual({
        error: "storage_failure",
      });
    }).pipe(Effect.provide(bindingsLayer)),
  );
});
