import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Bindings, blobStorageEffect, databaseLayer } from "../src/platform/cloudflare.js";
import { SkitDeletion, layer as skitDeletionLayer } from "../src/skit-delete/service.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const bindingsLayer = Layer.merge(Layer.succeed(Bindings, bindings), databaseLayer(env.DB));
const testLayer = skitDeletionLayer.pipe(Layer.provideMerge(bindingsLayer));

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql.unsafe("DROP TABLE IF EXISTS resource_grants"),
    sql.unsafe("DROP TABLE IF EXISTS draft_files"),
    sql.unsafe("DROP TABLE IF EXISTS draft_revisions"),
    sql.unsafe("DROP TABLE IF EXISTS releases"),
    sql.unsafe("DROP TABLE IF EXISTS drafts"),
    sql.unsafe(`CREATE TABLE drafts (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
      PRIMARY KEY (owner_slug, skit_slug)
    )`),
    sql.unsafe(`CREATE TABLE draft_revisions (
      revision_id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL
    )`),
    sql.unsafe(`CREATE TABLE draft_files (
      revision_id TEXT NOT NULL, path TEXT NOT NULL,
      PRIMARY KEY (revision_id, path)
    ) WITHOUT ROWID`),
    sql.unsafe(`CREATE TABLE releases (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
      release_id TEXT NOT NULL UNIQUE, archive_object_key TEXT NOT NULL,
      published_at TEXT NOT NULL, visibility TEXT NOT NULL,
      PRIMARY KEY (owner_slug, skit_slug, version)
    )`),
    sql.unsafe(`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL
    )`),
  ]),
);

describe("private SKIT deletion", () => {
  it.effect("previews and atomically deletes relational state and archives", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const deletion = yield* SkitDeletion;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("INSERT INTO drafts VALUES ('tim', 'tools', 'private')"),
          sql.unsafe("INSERT INTO draft_revisions VALUES ('rev_one', 'tim', 'tools')"),
          sql.unsafe("INSERT INTO draft_files VALUES ('rev_one', 'SKILL.md')"),
          sql.unsafe(
            `INSERT INTO releases VALUES
             ('tim', 'tools', '1.0.0', 'rel_one', 'releases/one.zip',
              '2026-01-01T00:00:00Z', 'private')`,
          ),
          sql.unsafe("INSERT INTO resource_grants VALUES ('grant_release', 'release', 'rel_one')"),
          sql.unsafe("INSERT INTO resource_grants VALUES ('grant_skit', 'skit', 'tim/tools')"),
        ]),
      );
      yield* blobStorageEffect("insert deletion archive", (bucket) =>
        bucket.put("releases/one.zip", "private archive"),
      );

      expect(yield* deletion.plan("tim", "tools")).toEqual({
        skit_id: "tim/tools",
        draft_revisions: 1,
        releases: 1,
        release_versions: ["1.0.0"],
      });
      expect(yield* deletion.delete("tim", "tools")).toEqual({
        status: "deleted",
        changed: true,
        archive_cleanup: "complete",
        skit_id: "tim/tools",
        draft_revisions: 1,
        releases: 1,
        release_versions: ["1.0.0"],
      });
      for (const table of [
        "drafts",
        "draft_revisions",
        "draft_files",
        "releases",
        "resource_grants",
      ]) {
        const rows = yield* Effect.flatMap(D1Client.D1Client, (sql) =>
          sql.unsafe(`SELECT COUNT(*) count FROM ${table}`),
        );
        expect(rows[0]).toEqual({ count: 0 });
      }
      expect(
        yield* blobStorageEffect("check deleted archive", (bucket) =>
          bucket.head("releases/one.zip"),
        ),
      ).toBeNull();
      expect(yield* deletion.delete("tim", "tools")).toMatchObject({
        status: "absent",
        changed: false,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses deletion if either the draft or a release is visible", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const deletion = yield* SkitDeletion;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql.unsafe("INSERT INTO drafts VALUES ('tim', 'tools', 'private')"),
          sql.unsafe(
            `INSERT INTO releases VALUES
             ('tim', 'tools', '1.0.0', 'rel_one', 'releases/one.zip',
              '2026-01-01T00:00:00Z', 'public')`,
          ),
        ]),
      );

      expect(yield* Effect.flip(deletion.plan("tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.RequiresPrivate",
      });
      expect(yield* Effect.flip(deletion.delete("tim", "tools"))).toMatchObject({
        _tag: "SkitDelete.RequiresPrivate",
      });
      const rows = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) count FROM drafts`,
      );
      expect(rows[0]).toEqual({ count: 1 });
    }).pipe(Effect.provide(testLayer)),
  );
});
