/* oxlint-disable skit/no-promise-wrappers -- Cloudflare migrations and D1 are native Promise test-host APIs. */
import { applyD1Migrations, env, reset } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

it.effect("the Draft revisions migration drops old snapshots and clears current", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => reset());
    const name = "0010_draft_revisions";
    yield* Effect.promise(() =>
      applyD1Migrations(
        env.DB,
        env.TEST_MIGRATIONS.filter((migration) => migration.name < name),
      ),
    );
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(`INSERT INTO drafts
          (owner_slug, skit_slug, title, description, visibility, current_revision_id, created_at, updated_at)
          VALUES ('alice', 'tools', 'Tools', '', 'private', 'draft_old', 'then', 'then')`),
        env.DB.prepare(`INSERT INTO draft_revisions
          (revision_id, owner_slug, skit_slug, parent_revision_id, bundle_digest, descriptor_json, diagnostics_json, created_at)
          VALUES ('draft_old', 'alice', 'tools', NULL, 'sha256:old', '{}', '[]', 'then')`),
        env.DB.prepare(`INSERT INTO draft_files
          (revision_id, path, blob_digest, byte_length, media_type, executable, object_key)
          VALUES ('draft_old', 'skit.json', 'sha256:old', 2, 'application/json', 0, 'draft-blobs/old')`),
      ]),
    );
    const latest = env.TEST_MIGRATIONS.filter((migration) => migration.name.startsWith(name));
    expect(latest).toHaveLength(1);
    yield* Effect.promise(() => applyD1Migrations(env.DB, latest));

    // `title` and `description` are gone with the snapshots.
    expect(yield* Effect.promise(() => env.DB.prepare("SELECT * FROM drafts").first())).toEqual({
      owner_slug: "alice",
      skit_slug: "tools",
      visibility: "private",
      current_revision_id: null,
      created_at: "then",
      updated_at: "then",
    });
    const tables = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'draft%' ORDER BY name",
      ).all<{ name: string }>(),
    );
    expect(tables.results.map(({ name }) => name)).toEqual([
      "draft_revision_parents",
      "draft_revisions",
      "draft_tree_entries",
      "draft_trees",
      "drafts",
    ]);
    expect(
      yield* Effect.promise(() =>
        env.DB.prepare("SELECT COUNT(*) count FROM draft_revisions").first(),
      ),
    ).toEqual({ count: 0 });
  }),
);
