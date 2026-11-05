import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- D1 and the migration runner are Promise-only test-host APIs.
  Effect.promise(evaluate);

it.effect(
  "removes obsolete SDK counters while preserving identity and every other domain table",
  () =>
    Effect.gen(function* () {
      yield* host(() => reset());
      const migrationName = "0014_remove_auth_rate_limit";
      yield* host(() =>
        applyD1Migrations(
          env.DB,
          env.TEST_MIGRATIONS.filter((entry) => entry.name < migrationName),
        ),
      );
      const statements = [
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, username)
        VALUES ('user_fixture', 'Alice', 'alice@example.test', 1, 1, 1, 'alice')`,
        `INSERT INTO principals (principal_id, better_auth_user_id, state, authorization_generation, created_at, updated_at)
        VALUES ('principal_fixture', 'user_fixture', 'active', 7, 'created', 'updated')`,
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, authorizationGeneration)
        VALUES ('session_fixture', 999, 'session-token-fixture', 1, 1, 'user_fixture', 7)`,
        `INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt)
        VALUES ('account_fixture', 'local:credential', 'user_fixture', 'credential', 'user_fixture', 'fixture-hash', 1, 1)`,
        `INSERT INTO personal_access_tokens (token_id, principal_id, token_hash, token_prefix, name, scopes_json, authorization_generation, created_at)
        VALUES ('pat_fixture', 'principal_fixture', 'fixture-token-hash', 'skit_pat_fixture', 'fixture', '["authoring:write"]', 7, 'created')`,
        `INSERT INTO namespaces VALUES ('alice', 'principal', 'principal_fixture', 'created')`,
        `INSERT INTO server_operators VALUES ('principal_fixture', 'created')`,
        `INSERT INTO server_bootstrap VALUES ('singleton', 'created', 'principal_fixture')`,
        `INSERT INTO rateLimit VALUES ('legacy_counter', 'legacy-key', 42, 1234)`,
      ];
      yield* host(() => env.DB.batch(statements.map((sql) => env.DB.prepare(sql))));
      const counters = yield* host(() => env.DB.prepare("SELECT * FROM rateLimit").all());
      expect(counters.results).toHaveLength(1);
      const tables = yield* host(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('rateLimit', 'd1_migrations') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ).all<{ name: string }>(),
      );
      const before = yield* Effect.forEach(tables.results, ({ name }) =>
        host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all()),
      );
      const migration = env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(migrationName));
      expect(migration).toHaveLength(1);
      yield* host(() => applyD1Migrations(env.DB, migration));
      const removed = yield* host(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'rateLimit' OR tbl_name = 'rateLimit'",
        ).all(),
      );
      expect(removed.results).toEqual([]);
      for (const [index, { name }] of tables.results.entries()) {
        const after = yield* host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all());
        expect(after.results).toEqual(before[index]?.results);
      }
      const foreignKeys = yield* host(() => env.DB.prepare("PRAGMA foreign_key_check").all());
      expect(foreignKeys.results).toEqual([]);
    }),
);
