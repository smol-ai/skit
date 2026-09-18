import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { AuthorInventory, layer as authorInventoryLayer } from "../src/author-inventory/service.js";
import { layer as authorizationLayer } from "../src/authorization/service.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const bindingsLayer = Layer.merge(Layer.succeed(Bindings, bindings), databaseLayer(env.DB));
const testLayer = authorInventoryLayer.pipe(
  Layer.provideMerge(authorizationLayer.pipe(Layer.provideMerge(bindingsLayer))),
);
const principal = {
  id: "principal_test",
  credential: "session" as const,
  scopes: new Set(["authoring:write" as const]),
};

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql`DROP TABLE IF EXISTS releases`,
    sql`DROP TABLE IF EXISTS drafts`,
    sql`DROP TABLE IF EXISTS resource_grants`,
    sql`DROP TABLE IF EXISTS namespaces`,
    sql`DROP TABLE IF EXISTS team_memberships`,
    sql`CREATE TABLE team_memberships (team_id TEXT, principal_id TEXT, PRIMARY KEY (team_id, principal_id))`,
    sql`CREATE TABLE namespaces (namespace_slug TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT)`,
    sql`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, subject_kind TEXT, subject_id TEXT,
      resource_kind TEXT, resource_id TEXT, permission TEXT
    )`,
    sql`CREATE TABLE drafts (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL,
      current_revision_id TEXT, PRIMARY KEY (owner_slug, skit_slug)
    )`,
    sql`CREATE TABLE releases (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, version TEXT NOT NULL,
      published_at TEXT NOT NULL
    )`,
  ]),
);

describe("author inventory", () => {
  it.effect("merges owned and granted drafts into a stable cursor page", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const inventory = yield* AuthorInventory;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO namespaces VALUES ('tim', 'principal', 'principal_test')`,
          sql`INSERT INTO resource_grants VALUES ('grant_external', 'principal', 'principal_test', 'skit', 'zed/shared', 'read')`,
          sql`INSERT INTO drafts VALUES ('tim', 'alpha', 'private', 'rev_alpha')`,
          sql`INSERT INTO drafts VALUES ('tim', 'tools', 'unlisted', 'rev_tools')`,
          sql`INSERT INTO drafts VALUES ('zed', 'shared', 'public', 'rev_shared')`,
          sql`INSERT INTO drafts VALUES ('other', 'hidden', 'private', 'rev_hidden')`,
          sql`INSERT INTO releases VALUES ('tim', 'alpha', '1.0.0', '2026-01-01T00:00:00Z')`,
          sql`INSERT INTO releases VALUES ('tim', 'alpha', '1.1.0', '2026-02-01T00:00:00Z')`,
        ]),
      );

      const first = yield* inventory.read(principal, { limit: "2" });
      const second = yield* inventory.read(principal, { limit: "2", cursor: "tim/tools" });

      expect(first).toEqual({
        outcome: "page",
        skits: [
          {
            skit_id: "tim/alpha",
            visibility: "private",
            draft_revision_id: "rev_alpha",
            most_recent_release_version: "1.1.0",
          },
          {
            skit_id: "tim/tools",
            visibility: "unlisted",
            draft_revision_id: "rev_tools",
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
            draft_revision_id: "rev_shared",
            most_recent_release_version: null,
          },
        ],
        next_cursor: null,
      });
      expect(yield* inventory.read(principal, { cursor: "invalid" })).toEqual({
        outcome: "invalid_cursor",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("returns an empty page when the principal has no author access", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const inventory = yield* AuthorInventory;

      expect(yield* inventory.read(principal)).toEqual({
        outcome: "page",
        skits: [],
        next_cursor: null,
      });
    }).pipe(Effect.provide(testLayer)),
  );
});
