import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeNamespaceAccess } from "../src/identity/namespaces.js";
import { layer as teamsLayer } from "../src/teams/service.js";
import { BrowserCrypto } from "@effect/platform-browser";
import { databaseLayer } from "../src/platform/cloudflare.js";

const platformLayer = Layer.merge(databaseLayer(env.DB), BrowserCrypto.layer);
const testLayer = teamsLayer.pipe(Layer.provideMerge(platformLayer));
const principal = {
  id: "principal_test",
  credential: "session" as const,
  scopes: new Set(["authoring:write" as const]),
};

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql`DROP TABLE IF EXISTS resource_grants`,
    sql`DROP TABLE IF EXISTS namespaces`,
    sql`DROP TABLE IF EXISTS team_memberships`,
    sql`CREATE TABLE team_memberships (
      team_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      PRIMARY KEY (team_id, principal_id)
    ) WITHOUT ROWID`,
    sql`CREATE TABLE namespaces (
      namespace_slug TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL
    ) WITHOUT ROWID`,
    sql`CREATE TABLE resource_grants (
      grant_id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL, permission TEXT NOT NULL
    )`,
  ]),
);

describe("Identity namespace access", () => {
  it.effect("checks principal and current team namespace ownership", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const namespaceAccess = yield* makeNamespaceAccess();
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO team_memberships (team_id, principal_id) VALUES ('team_tools', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('personal', 'principal', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('teamspace', 'team', 'team_tools')`,
        ]),
      );

      expect(yield* namespaceAccess.ownsNamespace(principal, "PERSONAL")).toBe(true);
      expect(yield* namespaceAccess.ownsNamespace(principal, "teamspace")).toBe(true);
      expect(yield* namespaceAccess.ownsNamespace(principal, "admin")).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("lists owned namespaces without interpreting legacy grants", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const namespaceAccess = yield* makeNamespaceAccess();
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO team_memberships (team_id, principal_id) VALUES ('team_tools', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('personal', 'principal', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('teamspace', 'team', 'team_tools')`,
          sql`INSERT INTO resource_grants
             (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
             VALUES ('grant_one', 'principal', 'principal_test', 'skit', 'shared/tool', 'change')`,
          sql`INSERT INTO resource_grants
             (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
             VALUES ('grant_two', 'team', 'team_tools', 'skit', 'shared/tool', 'admin')`,
        ]),
      );

      const namespaces = yield* namespaceAccess.ownedNamespaces(principal);

      expect(new Set(namespaces)).toEqual(new Set(["personal", "teamspace"]));
    }).pipe(Effect.provide(testLayer)),
  );
});
