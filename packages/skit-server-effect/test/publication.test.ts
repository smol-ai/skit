import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { zipSync } from "fflate";
import { sha256Hash } from "@smolai/skit-core/universal/consumer";
import { BlobStore, blobStoreLayer, databaseLayer } from "../src/platform/cloudflare.js";
import { Skits, layer as skitsLayer } from "../src/skits/service.js";

const testLayer = skitsLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(blobStoreLayer(env.SKIT_BLOBS), databaseLayer(env.DB), BrowserCrypto.layer),
  ),
);
const bytes = (value: string) => new TextEncoder().encode(value);

const descriptor = {
  skit: 1,
  id: "alice/tools",
  slug: "tools",
  skills: [{ name: "review", path: "skills/review", default_enabled: true }],
};
const files = new Map([
  [
    "skit.json",
    bytes(
      JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", default_enabled: true }],
      }),
    ),
  ],
  ["skills/review/SKILL.md", bytes("---\nname: review\n---\n# Review\n")],
]);

const prepareDatabase = Effect.fn("PublicationTest.prepareDatabase")(function* () {
  yield* Effect.flatMap(D1Client.D1Client, (sql) =>
    sql.batch([
      sql`DROP TABLE IF EXISTS releases`,
      sql`DROP TABLE IF EXISTS revision_tree_entries`,
      sql`DROP TABLE IF EXISTS revisions`,
      sql`DROP TABLE IF EXISTS skits`,
      sql`CREATE TABLE skits (
        owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
        current_revision_id TEXT, PRIMARY KEY (owner_slug, skit_slug)
      )`,
      sql`CREATE TABLE revisions (
        owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, revision_id TEXT NOT NULL,
        tree_hash TEXT NOT NULL, descriptor_json TEXT NOT NULL
      )`,
      sql`CREATE TABLE revision_tree_entries (
        tree_hash TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, mode INTEGER,
        blob_hash TEXT, byte_length INTEGER
      )`,
      sql`CREATE TABLE releases (
        owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
        release_id TEXT NOT NULL UNIQUE, source_revision TEXT, archive_digest TEXT NOT NULL,
        archive_bytes INTEGER NOT NULL, archive_object_key TEXT NOT NULL UNIQUE,
        published_at TEXT NOT NULL, visibility TEXT NOT NULL,
        PRIMARY KEY (owner_slug, skit_slug, version)
      )`,
      sql`INSERT INTO skits VALUES ('alice', 'tools', 'private', 'sha256:1111111111111111111111111111111111111111111111111111111111111111')`,
      sql`INSERT INTO revisions
          VALUES ('alice', 'tools', 'sha256:1111111111111111111111111111111111111111111111111111111111111111', 'tree_current', ${JSON.stringify(descriptor)})`,
    ]),
  );
  for (const [path, content] of files) {
    const digest = yield* sha256Hash(content);
    yield* Effect.flatMap(
      D1Client.D1Client,
      (sql) =>
        sql`INSERT INTO revision_tree_entries VALUES ('tree_current', ${path}, 'file', 420, ${digest},
            ${content.byteLength})`,
    );
  }
});

describe("Publication", () => {
  it.effect("publishes the exact current skit snapshot to D1 and R2", () =>
    Effect.gen(function* () {
      yield* prepareDatabase();
      const skits = yield* Skits;
      const archive = zipSync(Object.fromEntries(files));
      const published = yield* skits.publish({
        owner: "alice",
        slug: "tools",
        version: "1.2.3",
        revisionId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        archive,
      });

      expect(published.release_id).toMatch(/^rel_[0-9a-f-]{36}$/);
      expect(published.revision_id).toBe(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      );
      expect(published.archive_digest).toBe(yield* sha256Hash(archive));
      const storedRows = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT archive_object_key, visibility, source_revision FROM releases
              WHERE release_id = ${published.release_id}`,
      );
      const stored = storedRows[0] as
        | { archive_object_key: string; visibility: string; source_revision: string }
        | undefined;
      expect(stored).toMatchObject({
        visibility: "private",
        source_revision: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      });
      expect(stored).toBeDefined();
      if (stored !== undefined)
        expect(
          yield* Effect.flatMap(BlobStore, (blobs) =>
            blobs.exists("find published archive", stored.archive_object_key),
          ),
        ).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects stale revisions and duplicate versions without writing archives", () =>
    Effect.gen(function* () {
      yield* prepareDatabase();
      const skits = yield* Skits;
      const archive = zipSync(Object.fromEntries(files));
      const stale = yield* Effect.result(
        skits.publish({
          owner: "alice",
          slug: "tools",
          version: "1.0.0",
          revisionId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          archive,
        }),
      );
      expect(stale._tag).toBe("Failure");
      if (stale._tag === "Failure") expect(stale.failure._tag).toBe("Publication.StaleRevision");

      yield* skits.publish({ owner: "alice", slug: "tools", version: "1.0.0", archive });
      const conflict = yield* Effect.result(
        skits.publish({ owner: "alice", slug: "tools", version: "1.0.0", archive }),
      );
      expect(conflict._tag).toBe("Failure");
      if (conflict._tag === "Failure")
        expect(conflict.failure._tag).toBe("Publication.ReleaseConflict");
    }).pipe(Effect.provide(testLayer)),
  );
});
