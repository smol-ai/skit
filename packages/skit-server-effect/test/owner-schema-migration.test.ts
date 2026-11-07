import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- D1 and the migration runner are Promise-only test-host APIs.
  Effect.promise(evaluate);
const name = "0010_owner_schema";
const previous = () => env.TEST_MIGRATIONS.filter((entry) => entry.name < name);
const upgrade = () => env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(name));

it.effect(
  "one upgrade from dev preserves identity, releases and Library data and installs the final owner schema",
  () =>
    Effect.gen(function* () {
      yield* host(() => reset());
      yield* host(() => applyD1Migrations(env.DB, previous()));
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
        `INSERT INTO drafts VALUES ('alice', 'tools', 'Tools', '', 'private', 'revision_two', 'created', 'updated')`,
        `INSERT INTO draft_revisions VALUES ('revision_one', 'alice', 'tools', NULL, 'sha256:one', '{}', '[]', 'first'),
          ('revision_two', 'alice', 'tools', 'revision_one', 'sha256:two', '{}', '[]', 'second')`,
        `INSERT INTO draft_files VALUES ('revision_two', 'skit.json', 'sha256:two', 2, 'application/json', 0, 'draft-blobs/two')`,
        `INSERT INTO releases (owner_slug, skit_slug, version, release_id, source_revision, archive_digest, archive_bytes, archive_object_key, published_at, visibility, adopted_content_digest)
        VALUES ('alice', 'tools', '1.0.0', 'release_one', 'revision_one', 'digest_one', 12, 'archive_one', 'first', 'private', 'legacy_digest'),
               ('alice', 'tools', '2.0.0', 'release_two', 'revision_two', 'digest_two', 24, 'archive_two', 'second', 'public', NULL)`,
        `INSERT INTO libraries VALUES ('library_fixture', 'principal', 'principal_fixture', 'library_rev', 'created', 'updated')`,
        `INSERT INTO library_revisions VALUES ('library_rev', 'library_fixture', NULL, '{}', 'created')`,
        `INSERT INTO library_snapshots VALUES ('library_fixture', 'snapshot_fixture', 'ready', 12, 'library_fixture/snapshot', 'created', 'ready')`,
        `INSERT INTO resource_grants VALUES ('grant_fixture', 'principal', 'principal_fixture', 'namespace', 'alice', 'admin', 'created')`,
        `INSERT INTO rateLimit VALUES ('legacy_counter', 'legacy-key', 42, 1234)`,
      ];
      yield* host(() => env.DB.batch(statements.map((sql) => env.DB.prepare(sql))));
      const tables = yield* host(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('drafts', 'draft_files', 'draft_revisions', 'resource_grants', 'rateLimit', 'releases', 'd1_migrations') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        ).all<{ name: string }>(),
      );
      const before = yield* Effect.forEach(tables.results, ({ name }) =>
        host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all()),
      );
      const releases = yield* host(() =>
        env.DB.prepare("SELECT * FROM releases ORDER BY version").all(),
      );
      expect(upgrade()).toHaveLength(1);
      yield* host(() => applyD1Migrations(env.DB, upgrade()));
      for (const [index, { name }] of tables.results.entries()) {
        expect(
          (yield* host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all())).results,
        ).toEqual(before[index]?.results);
      }
      expect(
        (yield* host(() => env.DB.prepare("SELECT * FROM releases ORDER BY version").all()))
          .results,
      ).toEqual(releases.results.map(({ adopted_content_digest: _legacy, ...row }) => row));
      expect(yield* host(() => env.DB.prepare("SELECT * FROM skits").first())).toEqual({
        owner_slug: "alice",
        skit_slug: "tools",
        visibility: "private",
        current_revision_id: null,
        created_at: "created",
        updated_at: "updated",
        creation_request_id: null,
      });
      expect(
        (yield* host(() =>
          env.DB.prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('drafts', 'draft_files', 'draft_revisions', 'resource_grants', 'rateLimit', 'idx_releases_adopted_content')",
          ).all(),
        )).results,
      ).toEqual([]);
      expect(
        (yield* host(() =>
          env.DB.prepare("PRAGMA table_info(releases)").all<{ name: string }>(),
        )).results.map(({ name }) => name),
      ).not.toContain("adopted_content_digest");

      // Final revision relationships and constraints work without intermediate Draft tables.
      yield* host(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO revision_trees VALUES ('tree_fixture')"),
          env.DB.prepare(
            "INSERT INTO revision_tree_entries VALUES ('tree_fixture', 'skills/review/SKILL.md', 'file', 420, 'blob_fixture', 12, NULL)",
          ),
          env.DB.prepare(`INSERT INTO revisions VALUES
        ('alice', 'tools', 'rev_one', 'tree_fixture', 'device_fixture', 1, 'null', '[]', 'pat_fixture', 'first'),
        ('alice', 'tools', 'rev_two', 'tree_fixture', 'device_fixture', 2, 'null', '[]', 'pat_fixture', 'second')`),
          env.DB.prepare(
            "INSERT INTO revision_parents VALUES ('alice', 'tools', 'rev_two', 0, 'rev_one')",
          ),
        ]),
      );
      const missing = yield* Effect.exit(
        host(() =>
          env.DB.prepare(
            "INSERT INTO revision_parents VALUES ('alice', 'tools', 'rev_two', 1, 'missing')",
          ).run(),
        ),
      );
      expect(missing._tag).toBe("Failure");
      for (const [version, id, key, constraint] of [
        ["1.0.0", "new_id", "new_key", "releases.owner_slug, releases.skit_slug, releases.version"],
        ["3.0.0", "release_one", "new_key", "releases.release_id"],
        ["3.0.0", "new_id", "archive_one", "releases.archive_object_key"],
      ]) {
        const result = yield* Effect.exit(
          host(() =>
            env.DB.prepare(
              `INSERT INTO releases (owner_slug, skit_slug, version, release_id, archive_digest, archive_bytes, archive_object_key, published_at, visibility)
         VALUES ('alice', 'tools', ?, ?, 'digest_new', 1, ?, 'third', 'private')`,
            )
              .bind(version, id, key)
              .run(),
          ),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.pretty(result.cause)).toContain(`UNIQUE constraint failed: ${constraint}`);
      }
      expect((yield* host(() => env.DB.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
        [],
      );
    }),
);

it.effect("the dev upgrade discards legacy Draft content and keeps the SKIT row", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    yield* host(() => applyD1Migrations(env.DB, previous()));
    yield* host(() =>
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO drafts VALUES ('alice', 'tools', 'Tools', '', 'private', 'draft_old', 'then', 'then')",
        ),
        env.DB.prepare(
          `INSERT INTO draft_revisions VALUES ('draft_old', 'alice', 'tools', NULL, 'sha256:old', '{}', '[]', 'then')`,
        ),
        env.DB.prepare(
          `INSERT INTO draft_files VALUES ('draft_old', 'skit.json', 'sha256:old', 2, 'application/json', 0, 'draft-blobs/old')`,
        ),
      ]),
    );
    yield* host(() => applyD1Migrations(env.DB, upgrade()));
    expect((yield* host(() => env.DB.prepare("SELECT * FROM skits").all())).results).toEqual([
      {
        owner_slug: "alice",
        skit_slug: "tools",
        visibility: "private",
        current_revision_id: null,
        created_at: "then",
        updated_at: "then",
        creation_request_id: null,
      },
    ]);
    expect(
      (yield* host(() =>
        env.DB.prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('draft_files', 'draft_revisions')",
        ).all(),
      )).results,
    ).toEqual([]);
    expect((yield* host(() => env.DB.prepare("PRAGMA foreign_key_check").all())).results).toEqual(
      [],
    );
  }),
);
