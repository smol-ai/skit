import type { DatabaseSqlClient } from "../platform/cloudflare.js";

export interface PrincipalProvisioning {
  readonly userId: string;
  readonly username: string;
  readonly principalId: string;
  readonly timestamp: string;
}

/**
 * The one write that makes a Better Auth user a Registry identity. A user is provisioned
 * when it has a username, a Principal, and that Principal's Namespace for the username.
 * Run the statements in one D1 batch: it is atomic, and re-running it converges, so signup,
 * bootstrap, sign-in repair, and username claims all share it. A user's username can change
 * here only while it has no Principal Namespace.
 */
export const provisionPrincipal = (
  sql: DatabaseSqlClient,
  { userId, username, principalId, timestamp }: PrincipalProvisioning,
) => [
  sql`UPDATE user SET username = ${username}
      WHERE id = ${userId} AND NOT EXISTS (
        SELECT 1 FROM principals p
        JOIN namespaces n ON n.subject_kind = 'principal' AND n.subject_id = p.principal_id
        WHERE p.better_auth_user_id = ${userId})`,
  sql`INSERT INTO principals (principal_id, better_auth_user_id, created_at, updated_at)
      VALUES (${principalId}, ${userId}, ${timestamp}, ${timestamp})
      ON CONFLICT(better_auth_user_id) DO NOTHING`,
  sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
      SELECT u.username, 'principal', p.principal_id, ${timestamp}
      FROM user u JOIN principals p ON p.better_auth_user_id = u.id
      WHERE u.id = ${userId} AND u.username = ${username} AND NOT EXISTS (
        SELECT 1 FROM namespaces n
        WHERE n.subject_kind = 'principal' AND n.subject_id = p.principal_id)`,
];
