import { Effect } from "effect";
import { databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";

/** Private commit API for Teams: inputs are normalized before its three-statement atomic batch. */
export const prepareTeamNamespaceClaim = (
  sql: DatabaseSqlClient,
  input: { readonly namespace: string; readonly teamId: string; readonly createdAt: string },
) => ({
  statement: sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
    VALUES (${input.namespace}, 'team', ${input.teamId}, ${input.createdAt})`,
  isTaken:
    sql`SELECT 1 found FROM namespaces WHERE namespace_slug = ${input.namespace} LIMIT 1`.pipe(
      databaseError("check namespace conflict"),
      Effect.map((rows) => rows.length !== 0),
    ),
});
