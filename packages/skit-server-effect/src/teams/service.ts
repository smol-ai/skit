import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../auth/authentication.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { Team, TeamMember } from "./contracts.js";
export { Team, TeamMember } from "./contracts.js";

const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{2,38}$/;
const TeamIdRow = Schema.Struct({ team_id: Schema.String });
const PrincipalIdRow = Schema.Struct({ principal_id: Schema.String });
const MembershipRoleRow = Schema.Struct({ role: Schema.Literals(["owner", "member"]) });

export class TeamSessionRequired extends Schema.TaggedError<TeamSessionRequired>()(
  "Team.SessionRequired",
  {},
) {}
export class InvalidTeam extends Schema.TaggedError<InvalidTeam>()("Team.Invalid", {}) {}
export class TeamConflict extends Schema.TaggedError<TeamConflict>()("Team.Conflict", {}) {}
export class TeamForbidden extends Schema.TaggedError<TeamForbidden>()("Team.Forbidden", {}) {}
export class TeamPrincipalNotFound extends Schema.TaggedError<TeamPrincipalNotFound>()(
  "Team.PrincipalNotFound",
  {},
) {}
export class OwnerRoleImmutable extends Schema.TaggedError<OwnerRoleImmutable>()(
  "Team.OwnerRoleImmutable",
  {},
) {}

export interface TeamsService {
  readonly create: (
    principal: Principal,
    input: { readonly slug: string; readonly name: string },
  ) => Effect.Effect<Team, TeamSessionRequired | InvalidTeam | TeamConflict | DatabaseError>;
  readonly addMember: (
    principal: Principal,
    slug: string,
    email: string,
  ) => Effect.Effect<
    TeamMember,
    TeamSessionRequired | TeamForbidden | TeamPrincipalNotFound | OwnerRoleImmutable | DatabaseError
  >;
  readonly removeMember: (
    principal: Principal,
    slug: string,
    memberPrincipalId: string,
  ) => Effect.Effect<boolean, TeamSessionRequired | TeamForbidden | DatabaseError>;
}

export class Teams extends Context.Service<Teams, TeamsService>()("@skit-server-effect/Teams") {}

export const layer = Layer.effect(
  Teams,
  Effect.gen(function* () {
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const crypto = yield* NativeCrypto;
    const clock = yield* Clock.Clock;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const ownedTeam = Effect.fn("Teams.ownedTeam")(function* (principal: Principal, slug: string) {
      const rows = yield* db(
        "find owned team",
        sql`SELECT t.team_id FROM teams t
           JOIN team_memberships m ON m.team_id = t.team_id
           WHERE t.slug = ${slug} AND m.principal_id = ${principal.id} AND m.role = 'owner'`,
      );
      if (rows[0] === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(TeamIdRow)(rows[0]).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation: "decode owned team", cause })),
      );
    });

    const create = Effect.fn("Teams.create")(function* (
      principal: Principal,
      input: { readonly slug: string; readonly name: string },
    ) {
      if (principal.credential !== "session") return yield* new TeamSessionRequired();
      const slug = normalizeNamespace(input.slug);
      const name = input.name.trim();
      if (slug === undefined || !TEAM_SLUG.test(slug) || !name) return yield* new InvalidTeam();
      const teamId = `team_${crypto.randomUUID().replaceAll("-", "")}`;
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      const committed = yield* db(
        "create team",
        sql.batch([
          sql`INSERT INTO teams (team_id, slug, name, created_at)
            VALUES (${teamId}, ${slug}, ${name}, ${now})`,
          sql`INSERT INTO team_memberships (team_id, principal_id, role, created_at)
            VALUES (${teamId}, ${principal.id}, 'owner', ${now})`,
          sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
            VALUES (${slug}, 'team', ${teamId}, ${now})`,
        ]),
      ).pipe(Effect.result);
      if (committed._tag === "Failure") {
        const conflict = yield* db(
          "check team conflict",
          sql`SELECT 1 found FROM teams WHERE slug = ${slug}
              UNION ALL SELECT 1 found FROM namespaces WHERE namespace_slug = ${slug} LIMIT 1`,
        );
        if (conflict.length !== 0) return yield* new TeamConflict();
        return yield* Effect.fail(committed.failure);
      }
      return { team_id: teamId, slug, name };
    });

    const addMember = Effect.fn("Teams.addMember")(function* (
      principal: Principal,
      slug: string,
      email: string,
    ) {
      if (principal.credential !== "session") return yield* new TeamSessionRequired();
      const team = yield* ownedTeam(principal, slug);
      if (team === undefined) return yield* new TeamForbidden();
      const memberRows = yield* db(
        "find team member principal",
        sql`SELECT p.principal_id FROM principals p
           JOIN user u ON u.id = p.better_auth_user_id
           WHERE lower(u.email) = lower(${email}) AND p.state = 'active'`,
      );
      if (memberRows[0] === undefined) return yield* new TeamPrincipalNotFound();
      const member = yield* Schema.decodeUnknownEffect(PrincipalIdRow)(memberRows[0]).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode team member principal", cause }),
        ),
      );
      const existingRows = yield* db(
        "read team membership",
        sql`SELECT role FROM team_memberships
            WHERE team_id = ${team.team_id} AND principal_id = ${member.principal_id}`,
      );
      if (existingRows[0] !== undefined) {
        const existing = yield* Schema.decodeUnknownEffect(MembershipRoleRow)(existingRows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode team membership", cause }),
          ),
        );
        if (existing.role === "owner") return yield* new OwnerRoleImmutable();
      }
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      yield* db(
        "add team member",
        sql`INSERT INTO team_memberships (team_id, principal_id, role, created_at)
            VALUES (${team.team_id}, ${member.principal_id}, 'member', ${now})
            ON CONFLICT(team_id, principal_id) DO UPDATE SET role = 'member'`,
      );
      return { principal_id: member.principal_id, role: "member" as const };
    });

    const removeMember = Effect.fn("Teams.removeMember")(function* (
      principal: Principal,
      slug: string,
      memberPrincipalId: string,
    ) {
      if (principal.credential !== "session") return yield* new TeamSessionRequired();
      const team = yield* ownedTeam(principal, slug);
      if (team === undefined) return yield* new TeamForbidden();
      const rows = yield* db(
        "remove team member",
        sql`DELETE FROM team_memberships
            WHERE team_id = ${team.team_id} AND principal_id = ${memberPrincipalId} AND role = 'member'
            RETURNING principal_id`,
      );
      return rows.length === 1;
    });

    return Teams.of({ create, addMember, removeMember });
  }),
);
