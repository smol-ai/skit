import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Cause, Effect } from "effect";

const host = <A>(evaluate: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- D1 and the migration runner are Promise-only test-host APIs.
  Effect.promise(evaluate);

it.effect("removes obsolete adoption metadata while retaining releases and their uniqueness", () =>
  Effect.gen(function* () {
    yield* host(() => reset());
    const migrationName = "0015_remove_release_adoption";
    yield* host(() =>
      applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS.filter((entry) => entry.name < migrationName),
      ),
    );
    yield* host(() =>
      env.DB.prepare(
        `INSERT INTO releases
         (owner_slug, skit_slug, version, release_id, source_revision, archive_digest, archive_bytes, archive_object_key, published_at, visibility, adopted_content_digest)
         VALUES ('alice', 'tools', '1.0.0', 'release_one', 'revision_one', 'digest_one', 12, 'archive_one', 'first', 'private', 'legacy_digest'),
                ('alice', 'tools', '2.0.0', 'release_two', 'revision_two', 'digest_two', 24, 'archive_two', 'second', 'public', NULL)`,
      ).run(),
    );
    const before = yield* host(() =>
      env.DB.prepare("SELECT * FROM releases ORDER BY version").all(),
    );
    const tables = yield* host(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('releases', 'd1_migrations') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      ).all<{ name: string }>(),
    );
    const otherRows = yield* Effect.forEach(tables.results, ({ name }) =>
      host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all()),
    );
    const migration = env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(migrationName));
    expect(migration).toHaveLength(1);
    yield* host(() => applyD1Migrations(env.DB, migration));
    const after = yield* host(() =>
      env.DB.prepare("SELECT * FROM releases ORDER BY version").all(),
    );
    expect(after.results).toEqual(
      before.results.map(({ adopted_content_digest: _legacy, ...release }) => release),
    );
    const columns = yield* host(() =>
      env.DB.prepare("PRAGMA table_info(releases)").all<{ name: string }>(),
    );
    expect(columns.results.map(({ name }) => name)).not.toContain("adopted_content_digest");
    const index = yield* host(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'idx_releases_adopted_content'",
      ).all(),
    );
    expect(index.results).toEqual([]);
    for (const [position, { name }] of tables.results.entries()) {
      const rows = yield* host(() => env.DB.prepare(`SELECT * FROM "${name}"`).all());
      expect(rows.results).toEqual(otherRows[position]?.results);
    }
    // Removing the legacy index must retain version, release ID and archive-key uniqueness.
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
    const foreignKeys = yield* host(() => env.DB.prepare("PRAGMA foreign_key_check").all());
    expect(foreignKeys.results).toEqual([]);
  }),
);
