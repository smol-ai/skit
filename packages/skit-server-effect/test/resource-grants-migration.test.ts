import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- D1 and the migration runner are Promise-only test-host APIs.
  Effect.promise(evaluate);

it.effect("drops legacy grants and indexes while preserving every other domain table", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    const name = "0013_remove_resource_grants";
    yield* host(() =>
      applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS.filter((entry) => entry.name < name),
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
      `INSERT INTO teams VALUES ('team_fixture', 'team-fixture', 'Team fixture', 'created')`,
      `INSERT INTO team_memberships VALUES ('team_fixture', 'principal_fixture', 'owner', 'created')`,
      `INSERT INTO namespaces VALUES ('alice', 'principal', 'principal_fixture', 'created'), ('team-fixture', 'team', 'team_fixture', 'created')`,
      `INSERT INTO server_operators VALUES ('principal_fixture', 'created')`,
      `INSERT INTO server_bootstrap VALUES ('singleton', 'created', 'principal_fixture')`,
      `INSERT INTO skits (owner_slug, skit_slug, visibility, current_revision_id, created_at, updated_at, creation_request_id)
        VALUES ('alice', 'tools', 'private', 'rev_two', 'created', 'updated', 'request_fixture')`,
      `INSERT INTO revision_trees VALUES ('tree_fixture')`,
      `INSERT INTO revision_tree_entries VALUES ('tree_fixture', 'skills/review/SKILL.md', 'file', 420, 'blob_fixture', 12, NULL)`,
      `INSERT INTO revisions VALUES
        ('alice', 'tools', 'rev_one', 'tree_fixture', 'device_fixture', 1, 'null', '[]', 'pat_fixture', 'first'),
        ('alice', 'tools', 'rev_two', 'tree_fixture', 'device_fixture', 2, 'null', '[]', 'pat_fixture', 'second')`,
      `INSERT INTO revision_parents VALUES ('alice', 'tools', 'rev_two', 0, 'rev_one')`,
      `INSERT INTO releases (owner_slug, skit_slug, version, release_id, source_revision, archive_digest, archive_bytes, archive_object_key, published_at, visibility)
        VALUES ('alice', 'tools', '1.0.0', 'release_fixture', 'rev_two', 'digest_fixture', 12, 'releases/fixture.zip', 'published', 'private')`,
      `INSERT INTO libraries VALUES ('library_fixture', 'principal', 'principal_fixture', 'library_rev', 'created', 'updated')`,
      `INSERT INTO library_revisions VALUES ('library_rev', 'library_fixture', NULL, '{}', 'created')`,
      `INSERT INTO library_snapshots VALUES ('library_fixture', 'snapshot_fixture', 'ready', 12, 'library_fixture/snapshot', 'created', 'ready')`,
      `INSERT INTO resource_grants VALUES
        ('grant_namespace', 'principal', 'principal_fixture', 'namespace', 'alice', 'admin', 'created'),
        ('grant_release', 'team', 'team_fixture', 'release', 'release_fixture', 'read', 'created')`,
    ];
    yield* host(() => env.DB.batch(statements.map((sql) => env.DB.prepare(sql))));
    const indexes = yield* host(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'resource_grants' AND sql IS NOT NULL ORDER BY name",
      ).all<{ name: string }>(),
    );
    expect(indexes.results.map(({ name }) => name)).toEqual([
      "idx_resource_grants_lookup",
      "idx_resource_grants_subject",
    ]);
    const tables = yield* host(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('resource_grants', 'd1_migrations') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      ).all<{ name: string }>(),
    );
    const before = yield* Effect.forEach(tables.results, ({ name }) =>
      host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all()),
    );
    const migration = env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(name));
    expect(migration).toHaveLength(1);
    yield* host(() => applyD1Migrations(env.DB, migration));
    const removed = yield* host(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'resource_grants' OR tbl_name = 'resource_grants'",
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
