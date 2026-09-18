import { env } from "cloudflare:test";
import { D1Client } from "@effect/sql-d1";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Authorization, layer as authorizationLayer } from "../src/authorization/service.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const bindingsLayer = Layer.merge(Layer.succeed(Bindings, bindings), databaseLayer(env.DB));
const testLayer = authorizationLayer.pipe(Layer.provideMerge(bindingsLayer));
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

describe("authorization", () => {
  it.effect("combines principal and team ownership with implied grants", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const authorization = yield* Authorization;
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`INSERT INTO team_memberships (team_id, principal_id) VALUES ('team_tools', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('personal', 'principal', 'principal_test')`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id) VALUES ('teamspace', 'team', 'team_tools')`,
          sql`INSERT INTO resource_grants
             (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
             VALUES ('grant_admin', 'team', 'team_tools', 'skit', 'external/tool', 'admin')`,
          sql`INSERT INTO resource_grants
             (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
             VALUES ('grant_publish', 'principal', 'principal_test', 'namespace', 'partner', 'publish')`,
          sql`INSERT INTO resource_grants
             (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission)
             VALUES ('grant_release', 'principal', 'principal_test', 'release', 'rel_secret', 'read')`,
        ]),
      );

      expect(yield* authorization.ownsNamespace(principal, "PERSONAL")).toBe(true);
      expect(yield* authorization.ownsNamespace(principal, "teamspace")).toBe(true);
      expect(yield* authorization.ownsNamespace(principal, "admin")).toBe(false);
      expect(yield* authorization.canAuthor(principal, "external", "tool", "read")).toBe(true);
      expect(yield* authorization.canAuthor(principal, "external", "tool", "advance")).toBe(true);
      expect(yield* authorization.canPublish(principal, "partner", "tool")).toBe(true);
      expect(yield* authorization.canReadRelease(principal, "rel_secret", "other", "tool")).toBe(
        true,
      );
      expect(
        yield* authorization.readableReleaseIds(
          principal,
          ["rel_secret", "rel_inaccessible"],
          "other",
          "tool",
        ),
      ).toEqual(new Set(["rel_secret"]));
      expect(yield* authorization.canDeleteSkit(principal, "external", "tool")).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("derives the deduplicated author inventory scope", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const authorization = yield* Authorization;
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

      const scope = yield* authorization.authorInventoryScope(principal);

      expect(new Set(scope.namespaces)).toEqual(new Set(["personal", "teamspace"]));
      expect(scope.skits).toEqual(["shared/tool"]);
    }).pipe(Effect.provide(testLayer)),
  );
});
