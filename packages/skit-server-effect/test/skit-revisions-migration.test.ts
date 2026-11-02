/* oxlint-disable skit/no-promise-wrappers -- D1 and the migration runner are native Promise test-host APIs. */
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

it.effect("moving revision ownership to SKITs preserves current, history, trees and parents", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const name = "0011_skit_revisions";
    yield* Effect.promise(() =>
      applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS.filter((migration) => migration.name < name),
      ),
    );
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO drafts VALUES ('alice', 'tools', 'private', 'revision-2', 'created', 'updated')`,
        ),
        env.DB.prepare(`INSERT INTO draft_trees VALUES ('tree-1')`),
        env.DB.prepare(`INSERT INTO draft_tree_entries
        VALUES ('tree-1', 'skills/review/SKILL.md', 'file', 420, 'blob-1', 12, NULL)`),
        env.DB.prepare(`INSERT INTO draft_revisions VALUES
        ('alice', 'tools', 'revision-1', 'tree-1', 'device-a', 1, 'null', '[]', NULL, 'first'),
        ('alice', 'tools', 'revision-2', 'tree-1', 'device-b', 2, 'null', '[]', NULL, 'second')`),
        env.DB.prepare(
          `INSERT INTO draft_revision_parents VALUES ('alice', 'tools', 'revision-2', 0, 'revision-1')`,
        ),
      ]),
    );
    const tables = [
      ["drafts", "skits"],
      ["draft_trees", "revision_trees"],
      ["draft_tree_entries", "revision_tree_entries"],
      ["draft_revisions", "revisions"],
      ["draft_revision_parents", "revision_parents"],
    ] as const;
    const before = yield* Effect.forEach(tables, ([old]) =>
      Effect.promise(() => env.DB.prepare(`SELECT * FROM ${old}`).all()),
    );
    const migration = env.TEST_MIGRATIONS.filter((entry) => entry.name.startsWith(name));
    expect(migration).toHaveLength(1);
    yield* Effect.promise(() => applyD1Migrations(env.DB, migration));
    for (const [index, [, current]] of tables.entries()) {
      const after = yield* Effect.promise(() => env.DB.prepare(`SELECT * FROM ${current}`).all());
      expect(after.results).toEqual(before[index]?.results);
    }
    const foreignKeys = yield* Effect.promise(() =>
      env.DB.prepare("PRAGMA foreign_key_check").all(),
    );
    expect(foreignKeys.results).toEqual([]);
    // Renamed parent relationships still enforce referential integrity.
    yield* Effect.promise(() =>
      expect(
        env.DB.prepare(`INSERT INTO revision_parents
      VALUES ('alice', 'tools', 'revision-2', 1, 'missing')`).run(),
      ).rejects.toThrow(),
    );
  }),
);
