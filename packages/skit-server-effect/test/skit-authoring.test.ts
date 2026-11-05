import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { layer as teamsLayer } from "../src/teams/service.js";
import { Skits, layer as skitsLayer } from "../src/skits/service.js";
import { blobStoreLayer, databaseLayer } from "../src/platform/cloudflare.js";
import { revisionRequest } from "./fixtures/revision-request.js";

const principal = {
  id: "principal_author",
  credential: "session" as const,
  scopes: new Set(["authoring:write"] as const),
};
const testLayer = skitsLayer.pipe(
  Layer.provide(teamsLayer),
  Layer.provideMerge(
    Layer.mergeAll(blobStoreLayer(env.SKIT_BLOBS), databaseLayer(env.DB), BrowserCrypto.layer),
  ),
);

it.effect("rechecks prepared authoring authority on all six operations", () =>
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const skits = yield* Skits;
    yield* sql.batch([
      sql`DROP TABLE IF EXISTS namespaces`,
      sql`DROP TABLE IF EXISTS team_memberships`,
      sql`DROP TABLE IF EXISTS skits`,
      sql`CREATE TABLE namespaces (namespace_slug TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL)`,
      sql`CREATE TABLE team_memberships (team_id TEXT NOT NULL, principal_id TEXT NOT NULL)`,
      sql`CREATE TABLE skits (owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, visibility TEXT NOT NULL, current_revision_id TEXT)`,
      sql`INSERT INTO skits VALUES ('alice', 'tools', 'private', NULL)`,
      sql`INSERT INTO namespaces VALUES ('alice', 'team', 'team_tools')`,
      sql`INSERT INTO team_memberships VALUES ('team_tools', ${principal.id})`,
    ]);
    const authoring = yield* skits.prepareAuthoring(principal, { owner: "alice", slug: "tools" });
    expect((yield* authoring.current())?.visibility).toBe("private");
    const request = yield* revisionRequest();
    yield* sql`DELETE FROM team_memberships WHERE team_id = 'team_tools' AND principal_id = ${principal.id}`;
    const results = yield* Effect.all([
      Effect.result(authoring.create("private")),
      Effect.result(authoring.current()),
      Effect.result(authoring.post(request)),
      Effect.result(authoring.move(null, request.id)),
      Effect.result(authoring.revision(request.id)),
      Effect.result(authoring.ancestors(request.id, 100, 0)),
    ]);
    for (const result of results)
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SKIT.Forbidden" } });
    expect(yield* sql`SELECT COUNT(*) count FROM skits`).toEqual([{ count: 1 }]);
  }).pipe(Effect.provide(testLayer)),
);
