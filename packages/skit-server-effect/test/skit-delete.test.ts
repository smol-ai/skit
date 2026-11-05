import { layer as teamsLayer } from "../src/teams/service.js";
import { BrowserCrypto } from "@effect/platform-browser";
import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BlobStore, blobStoreLayer, databaseLayer } from "../src/platform/cloudflare.js";
import { Skits, layer as skitsLayer } from "../src/skits/service.js";

const principal = {
  id: "principal_tim",
  credential: "session" as const,
  scopes: new Set(["authoring:write"] as const),
};

const platformLayer = Layer.mergeAll(
  blobStoreLayer(env.SKIT_BLOBS),
  databaseLayer(env.DB),
  BrowserCrypto.layer,
);
const testLayer = skitsLayer.pipe(Layer.provide(teamsLayer), Layer.provideMerge(platformLayer));

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS namespaces"),
    sql.unsafe("DROP TABLE IF EXISTS team_memberships"),
    sql.unsafe("CREATE TABLE team_memberships (team_id TEXT NOT NULL, principal_id TEXT NOT NULL)"),
    sql.unsafe(
      "CREATE TABLE namespaces (namespace_slug TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL)",
    ),
    sql.unsafe("INSERT INTO namespaces VALUES ('tim', 'principal', 'principal_tim')"),
    sql.unsafe("DROP TABLE IF EXISTS resource_grants"),
    sql.unsafe("DROP TABLE IF EXISTS revision_tree_entries"),
    sql.unsafe("DROP TABLE IF EXISTS revision_parents"),
    sql.unsafe("DROP TABLE IF EXISTS revisions"),
    sql.unsafe("DROP TABLE IF EXISTS revision_trees"),
    sql.unsafe("DROP TABLE IF EXISTS releases"),
    sql.unsafe("DROP TABLE IF EXISTS skits"),
    sql.unsafe(`CREATE TABLE skits (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
      PRIMARY KEY (owner_slug, skit_slug)
    )`),
    sql.unsafe("CREATE TABLE revision_trees (tree_hash TEXT PRIMARY KEY)"),
    sql.unsafe("CREATE TABLE revision_tree_entries (tree_hash TEXT NOT NULL, path TEXT NOT NULL)"),
    sql.unsafe(`CREATE TABLE revisions (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, revision_id TEXT NOT NULL,
      tree_hash TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE revision_parents (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, revision_id TEXT NOT NULL,
      parent_id TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE releases (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
      release_id TEXT NOT NULL UNIQUE, archive_object_key TEXT NOT NULL,
      published_at TEXT NOT NULL, visibility TEXT NOT NULL,
      PRIMARY KEY (owner_slug, skit_slug, version)
    )`),
  ]),
);

describe("private SKIT deletion", () => {
  it.effect("rechecks owning-team membership after a preview before deleting", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const sql = yield* D1Client.D1Client;
      const skits = yield* Skits;
      yield* sql.batch([
        sql`INSERT INTO skits VALUES ('tim', 'tools', 'private')`,
        sql`UPDATE namespaces SET subject_kind = 'team', subject_id = 'team_tools' WHERE namespace_slug = 'tim'`,
        sql`INSERT INTO team_memberships VALUES ('team_tools', ${principal.id})`,
      ]);
      expect(yield* skits.planDelete(principal, "tim", "tools")).toMatchObject({ releases: 0 });
      yield* sql`DELETE FROM team_memberships WHERE team_id = 'team_tools' AND principal_id = ${principal.id}`;
      expect(yield* Effect.flip(skits.delete(principal, "tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.NotFound",
      });
      expect(yield* Effect.flip(skits.planDelete(principal, "tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.NotFound",
      });
      expect(yield* sql`SELECT COUNT(*) count FROM skits`).toEqual([{ count: 1 }]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("previews and atomically deletes relational state and archives", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const skits = yield* Skits;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("INSERT INTO skits VALUES ('tim', 'tools', 'private')"),
          sql.unsafe("INSERT INTO skits VALUES ('ann', 'kept', 'private')"),
          // `tree_shared` is also recorded by another SKIT, so it outlives this deletion.
          sql.unsafe("INSERT INTO revision_trees VALUES ('tree_own'), ('tree_shared')"),
          sql.unsafe(
            "INSERT INTO revision_tree_entries VALUES ('tree_own', 'SKILL.md'), ('tree_shared', 'SKILL.md')",
          ),
          sql.unsafe(
            `INSERT INTO revisions VALUES
             ('tim', 'tools', 'rev_one', 'tree_own'), ('tim', 'tools', 'rev_two', 'tree_shared'),
             ('ann', 'kept', 'rev_kept', 'tree_shared')`,
          ),
          sql.unsafe("INSERT INTO revision_parents VALUES ('tim', 'tools', 'rev_two', 'rev_one')"),
          sql.unsafe(
            `INSERT INTO releases VALUES
             ('tim', 'tools', '1.0.0', 'rel_one', 'releases/one.zip',
              '2026-01-01T00:00:00Z', 'private')`,
          ),
        ]),
      );
      const blobs = yield* BlobStore;
      yield* blobs.put(
        "insert deletion archive",
        "releases/one.zip",
        new TextEncoder().encode("private archive"),
      );

      expect(yield* skits.planDelete(principal, "tim", "tools")).toEqual({
        skit_id: "tim/tools",
        revisions: 2,
        releases: 1,
        release_versions: ["1.0.0"],
      });
      expect(yield* skits.delete(principal, "tim", "tools")).toEqual({
        status: "deleted",
        changed: true,
        archive_cleanup: "complete",
        skit_id: "tim/tools",
        revisions: 2,
        releases: 1,
        release_versions: ["1.0.0"],
      });
      const remaining = (query: string) =>
        Effect.flatMap(D1Client.D1Client, (sql) => sql.unsafe(query));
      expect(yield* remaining("SELECT owner_slug, skit_slug FROM skits")).toEqual([
        { owner_slug: "ann", skit_slug: "kept" },
      ]);
      expect(yield* remaining("SELECT revision_id FROM revisions")).toEqual([
        { revision_id: "rev_kept" },
      ]);
      expect(yield* remaining("SELECT tree_hash FROM revision_trees")).toEqual([
        { tree_hash: "tree_shared" },
      ]);
      expect(yield* remaining("SELECT tree_hash FROM revision_tree_entries")).toEqual([
        { tree_hash: "tree_shared" },
      ]);
      for (const table of ["revision_parents", "releases"]) {
        const rows = yield* remaining(`SELECT COUNT(*) count FROM ${table}`);
        expect(rows[0]).toEqual({ count: 0 });
      }
      expect(yield* blobs.exists("check deleted archive", "releases/one.zip")).toBe(false);
      expect(yield* skits.delete(principal, "tim", "tools")).toMatchObject({
        status: "absent",
        changed: false,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses deletion if either the skit or a release is visible", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const skits = yield* Skits;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.unsafe("INSERT INTO skits VALUES ('tim', 'tools', 'private')"),
      );
      expect(yield* skits.planDelete(principal, "tim", "tools")).toMatchObject({ releases: 0 });
      // Publication after the passive preview must still prevent deletion in the SQL batch.
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe(
            `INSERT INTO releases VALUES
             ('tim', 'tools', '1.0.0', 'rel_one', 'releases/one.zip',
              '2026-01-01T00:00:00Z', 'public')`,
          ),
        ]),
      );

      expect(yield* Effect.flip(skits.planDelete(principal, "tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.RequiresPrivate",
      });
      expect(yield* Effect.flip(skits.delete(principal, "tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.RequiresPrivate",
      });
      const rows = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM skits`,
      );
      expect(rows[0]).toEqual({ count: 1 });
    }).pipe(Effect.provide(testLayer)),
  );
});
