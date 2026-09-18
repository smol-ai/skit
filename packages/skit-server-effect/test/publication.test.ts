import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { zipSync } from "fflate";
import { sha256 } from "../src/integrity/crypto.js";
import { Bindings, blobStorageEffect, databaseLayer } from "../src/platform/cloudflare.js";
import { Publication, layer as publicationLayer } from "../src/publication/service.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const testLayer = publicationLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Layer.succeed(Bindings, bindings), databaseLayer(env.DB), BrowserCrypto.layer),
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
      sql`DROP TABLE IF EXISTS draft_files`,
      sql`DROP TABLE IF EXISTS draft_revisions`,
      sql`DROP TABLE IF EXISTS drafts`,
      sql`CREATE TABLE drafts (
        owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
        current_revision_id TEXT, PRIMARY KEY (owner_slug, skit_slug)
      )`,
      sql`CREATE TABLE draft_revisions (
        revision_id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL,
        descriptor_json TEXT NOT NULL
      )`,
      sql`CREATE TABLE draft_files (
        revision_id TEXT NOT NULL, path TEXT NOT NULL, blob_digest TEXT NOT NULL,
        byte_length INTEGER NOT NULL, media_type TEXT NOT NULL, executable INTEGER NOT NULL
      )`,
      sql`CREATE TABLE releases (
        owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
        release_id TEXT NOT NULL UNIQUE, source_revision TEXT, archive_digest TEXT NOT NULL,
        archive_bytes INTEGER NOT NULL, archive_object_key TEXT NOT NULL UNIQUE,
        published_at TEXT NOT NULL, visibility TEXT NOT NULL,
        PRIMARY KEY (owner_slug, skit_slug, version)
      )`,
      sql`INSERT INTO drafts VALUES ('alice', 'tools', 'private', 'draft_current')`,
      sql`INSERT INTO draft_revisions
          VALUES ('draft_current', 'alice', 'tools', ${JSON.stringify(descriptor)})`,
    ]),
  );
  for (const [path, content] of files) {
    const digest = yield* sha256(content);
    yield* Effect.flatMap(
      D1Client.D1Client,
      (sql) =>
        sql`INSERT INTO draft_files VALUES ('draft_current', ${path}, ${digest},
            ${content.byteLength}, ${path === "skit.json" ? "application/json" : "text/markdown"}, 0)`,
    );
  }
});

describe("Publication", () => {
  it.effect("publishes the exact current draft snapshot to D1 and R2", () =>
    Effect.gen(function* () {
      yield* prepareDatabase();
      const publication = yield* Publication;
      const archive = zipSync(Object.fromEntries(files));
      const published = yield* publication.publish({
        owner: "alice",
        slug: "tools",
        version: "1.2.3",
        revisionId: "draft_current",
        archive,
      });

      expect(published.release_id).toMatch(/^rel_[0-9a-f-]{36}$/);
      expect(published.revision_id).toBe("draft_current");
      expect(published.archive_digest).toBe(yield* sha256(archive));
      const storedRows = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`SELECT archive_object_key, visibility, source_revision FROM releases
              WHERE release_id = ${published.release_id}`,
      );
      const stored = storedRows[0] as
        | { archive_object_key: string; visibility: string; source_revision: string }
        | undefined;
      expect(stored).toMatchObject({ visibility: "private", source_revision: "draft_current" });
      expect(stored).toBeDefined();
      if (stored !== undefined)
        expect(
          yield* blobStorageEffect("find published archive", (bucket) =>
            bucket.head(stored.archive_object_key),
          ),
        ).not.toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects stale revisions and duplicate versions without writing archives", () =>
    Effect.gen(function* () {
      yield* prepareDatabase();
      const publication = yield* Publication;
      const archive = zipSync(Object.fromEntries(files));
      const stale = yield* Effect.result(
        publication.publish({
          owner: "alice",
          slug: "tools",
          version: "1.0.0",
          revisionId: "draft_stale",
          archive,
        }),
      );
      expect(stale._tag).toBe("Failure");
      if (stale._tag === "Failure")
        expect(stale.failure._tag).toBe("Publication.StaleDraftRevision");

      yield* publication.publish({ owner: "alice", slug: "tools", version: "1.0.0", archive });
      const conflict = yield* Effect.result(
        publication.publish({ owner: "alice", slug: "tools", version: "1.0.0", archive }),
      );
      expect(conflict._tag).toBe("Failure");
      if (conflict._tag === "Failure")
        expect(conflict.failure._tag).toBe("Publication.ReleaseConflict");
    }).pipe(Effect.provide(testLayer)),
  );
});
