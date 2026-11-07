import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeWebHandler } from "../src/http.js";
import { passwordCallbacks } from "../src/identity/internal/password.js";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- D1, password callbacks and Worker handlers are Promise-only host APIs.
  Effect.promise(evaluate);
const name = "0011_better_auth_account_keys";
const previous = () => env.TEST_MIGRATIONS.filter((entry) => entry.name < name);
const upgrade = () => env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(name));

it.effect("preserves existing accounts and password sign-in when removing issuer", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    yield* host(() => applyD1Migrations(env.DB, previous()));
    const password = "existing account password";
    const hash = yield* host(() => passwordCallbacks(globalThis.crypto).hash(password));
    yield* host(() =>
      env.DB.batch([
        env.DB.prepare(`INSERT INTO user
          (id, name, email, emailVerified, createdAt, updatedAt, username)
          VALUES ('existing', 'Existing', 'existing@example.test', 1, 1, 1, 'existing')`),
        env.DB.prepare(`INSERT INTO account
          (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt)
          VALUES ('password-account', 'local:credential', 'existing', 'credential', 'existing', ?, 1, 1)`).bind(
          hash,
        ),
        env.DB.prepare(`INSERT INTO account
          (id, issuer, accountId, providerId, userId, accessToken, refreshToken, createdAt, updatedAt)
          VALUES ('github-account', 'https://github.com', 'existing', 'github', 'existing', 'access', 'refresh', 1, 1)`),
      ]),
    );
    const before = yield* host(() => env.DB.prepare("SELECT * FROM account ORDER BY id").all());
    expect(upgrade()).toHaveLength(1);
    yield* host(() => applyD1Migrations(env.DB, upgrade()));
    expect(
      (yield* host(() => env.DB.prepare("SELECT * FROM account ORDER BY id").all())).results,
    ).toEqual(before.results.map(({ issuer: _issuer, ...account }) => account));
    const columns = yield* host(() =>
      env.DB.prepare("PRAGMA table_info(account)").all<{ name: string }>(),
    );
    expect(columns.results.map(({ name }) => name)).not.toContain("issuer");
    const web = makeWebHandler(env);
    yield* Effect.gen(function* () {
      const response = yield* host(() =>
        web.handler(
          new Request("https://registry.test/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://registry.test" },
            body: JSON.stringify({ email: "existing@example.test", password }),
          }),
        ),
      );
      expect(response.status).toBe(200);
      const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
      const session = yield* host(() =>
        web.handler(
          new Request("https://registry.test/api/auth/get-session", {
            headers: { cookie },
          }),
        ),
      );
      expect(session.status).toBe(200);
      expect(yield* host(() => session.json())).toMatchObject({ user: { id: "existing" } });
    }).pipe(Effect.ensuring(host(() => web.dispose())));
  }),
);

it.effect("refuses ambiguous provider account keys without changing existing accounts", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    yield* host(() => applyD1Migrations(env.DB, previous()));
    yield* host(() =>
      env.DB.batch([
        env.DB.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('existing', 'Existing', 'existing@example.test', 1, 1, 1)`),
        env.DB.prepare(`INSERT INTO account
        (id, issuer, accountId, providerId, userId, createdAt, updatedAt)
        VALUES ('first', 'first-issuer', 'shared', 'github', 'existing', 1, 1),
               ('second', 'second-issuer', 'shared', 'github', 'existing', 1, 1)`),
      ]),
    );
    const before = yield* host(() => env.DB.prepare("SELECT * FROM account ORDER BY id").all());
    yield* host(() => expect(applyD1Migrations(env.DB, upgrade())).rejects.toThrow());
    expect(
      (yield* host(() => env.DB.prepare("SELECT * FROM account ORDER BY id").all())).results,
    ).toEqual(before.results);
    expect(
      yield* host(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'idx_account_issuer_account'",
        ).first(),
      ),
    ).toEqual({ name: "idx_account_issuer_account" });
  }),
);
