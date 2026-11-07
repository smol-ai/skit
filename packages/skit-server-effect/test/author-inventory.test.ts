import { BrowserCrypto } from "@effect/platform-browser";
import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Skits, layer as skitsLayer } from "../src/skits/service.js";
import { layer as teamsLayer } from "../src/teams/service.js";
import { databaseLayer, blobStoreLayer } from "../src/platform/cloudflare.js";

const platformLayer = Layer.mergeAll(
  databaseLayer(env.DB),
  blobStoreLayer(env.SKIT_BLOBS),
  BrowserCrypto.layer,
);
const testLayer = skitsLayer.pipe(
  Layer.provideMerge(teamsLayer.pipe(Layer.provideMerge(platformLayer))),
);
const principal = {
  id: "principal_test",
  credential: "session" as const,
  scopes: new Set(["authoring:write" as const]),
};

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql`DROP TABLE IF EXISTS releases`,
    sql`DROP TABLE IF EXISTS skits`,
    sql`DROP TABLE IF EXISTS resource_grants`,
    sql`DROP TABLE IF EXISTS namespaces`,
    sql`DROP TABLE IF EXISTS team_memberships`,
    sql`CREATE TABLE team_memberships (team_id TEXT, principal_id TEXT, PRIMARY KEY (team_id, principal_id))`,
    sql`CREATE TABLE namespaces (namespace_slug TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT)`,
    sql`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      resource_kind TEXT, resource_id TEXT, permission TEXT
    )`,
    sql`CREATE TABLE skits (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
      current_revision_id TEXT, PRIMARY KEY (owner_slug, skit_slug)
    )`,
    sql`CREATE TABLE releases (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
      published_at TEXT NOT NULL, source_revision TEXT
    )`,
  ]),
);

describe("author inventory", () => {
  it.effect("keeps keyset pagination complete across namespace and membership batches", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const sql = yield* D1Client.D1Client;
      const skits = yield* Skits;
      const expected: string[] = [];
      for (let index = 0; index < 45; index++) {
        const namespace = `team-${String(index).padStart(2, "0")}`;
        const team = `team_${index}`;
        expected.push(`${namespace}/tools`);
        yield* sql.batch([
          sql`INSERT INTO team_memberships VALUES (${team}, ${principal.id})`,
          sql`INSERT INTO namespaces VALUES (${namespace}, 'team', ${team})`,
          sql`INSERT INTO skits VALUES (${namespace}, 'tools', 'private', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
        ]);
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = yield* skits.list(principal, { limit: "7", cursor });
        if (result.outcome !== "page")
          return yield* Effect.die("unexpected invalid fixture cursor");
        seen.push(...result.skits.map((skit) => skit.skit_id));
        if (result.next_cursor === null) break;
        cursor = result.next_cursor;
      }
      expect(seen).toEqual(expected);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("merges principal and team namespaces into a stable cursor page, ignoring grants", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const skits = yield* Skits;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO namespaces VALUES ('tim', 'principal', 'principal_test'), ('zed', 'team', 'team_shared')`,
          sql`INSERT INTO team_memberships VALUES ('team_shared', 'principal_test')`,
          sql`INSERT INTO resource_grants VALUES ('grant_external', 'principal', 'principal_test', 'skit', 'other/hidden', 'admin')`,
          sql`INSERT INTO skits VALUES ('tim', 'alpha', 'private', 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
          sql`INSERT INTO skits VALUES ('tim', 'tools', 'unlisted', 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`,
          sql`INSERT INTO skits VALUES ('zed', 'shared', 'public', 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')`,
          sql`INSERT INTO skits VALUES ('other', 'hidden', 'private', 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')`,
          sql`INSERT INTO releases (owner_slug, skit_slug, version, published_at) VALUES ('tim', 'alpha', '1.0.0', '2026-01-01T00:00:00Z')`,
          sql`INSERT INTO releases (owner_slug, skit_slug, version, published_at) VALUES ('tim', 'alpha', '1.1.0', '2026-02-01T00:00:00Z')`,
        ]),
      );

      const first = yield* skits.list(principal, { limit: "2" });
      const second = yield* skits.list(principal, { limit: "2", cursor: "tim/tools" });

      expect(first).toEqual({
        outcome: "page",
        skits: [
          {
            skit_id: "tim/alpha",
            visibility: "private",
            current_revision_id:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            current_revision_published: false,
            most_recent_release_version: "1.1.0",
          },
          {
            skit_id: "tim/tools",
            visibility: "unlisted",
            current_revision_id:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            current_revision_published: false,
            most_recent_release_version: null,
          },
        ],
        next_cursor: "tim/tools",
      });
      expect(second).toEqual({
        outcome: "page",
        skits: [
          {
            skit_id: "zed/shared",
            visibility: "public",
            current_revision_id:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            current_revision_published: false,
            most_recent_release_version: null,
          },
        ],
        next_cursor: null,
      });
      yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) =>
          sql`DELETE FROM team_memberships WHERE team_id = 'team_shared' AND principal_id = 'principal_test'`,
      );
      expect(yield* skits.list(principal, { limit: "2", cursor: "tim/tools" })).toEqual({
        outcome: "page",
        skits: [],
        next_cursor: null,
      });
      yield* Effect.flatMap(D1Client.D1Client, (sql) => sql`DROP TABLE resource_grants`);
      const withoutGrants = yield* skits.list(principal, { limit: "2" });
      expect(
        withoutGrants.outcome === "page" && withoutGrants.skits.map((skit) => skit.skit_id),
      ).toEqual(["tim/alpha", "tim/tools"]);
      expect(yield* skits.list(principal, { cursor: "invalid" })).toEqual({
        outcome: "invalid_cursor",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns an empty page when the principal has no author access", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const skits = yield* Skits;

      expect(yield* skits.list(principal)).toEqual({
        outcome: "page",
        skits: [],
        next_cursor: null,
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
