import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { Principal } from "../identity/service.js";
import { prepareTeamNamespaceClaim } from "../identity/team-namespace.js";
import { normalizeNamespace } from "../identity/namespace-name.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import { SecureRandom } from "effect/crypto";
import { Team, TeamMember } from "@smolai/skit-core/api";

const TEAM_SLUG = /^[a-z0-9][a-z0-9-]{2,38}$/;
const TeamIdRow = Schema.Struct({ team_id: Schema.String });
const PrincipalIdRow = Schema.Struct({ principal_id: Schema.String });

class TeamSessionRequired extends Schema.TaggedError<
  TeamSessionRequired,
  { readonly brand: unique symbol }
>()("Team.SessionRequired", {}) {}
class InvalidTeam extends Schema.TaggedError<InvalidTeam, { readonly brand: unique symbol }>()(
  "Team.Invalid",
  {},
) {}
class TeamConflict extends Schema.TaggedError<TeamConflict, { readonly brand: unique symbol }>()(
  "Team.Conflict",
  {},
) {}
class TeamForbidden extends Schema.TaggedError<TeamForbidden, { readonly brand: unique symbol }>()(
  "Team.Forbidden",
  {},
) {}
class TeamPrincipalNotFound extends Schema.TaggedError<
  TeamPrincipalNotFound,
  { readonly brand: unique symbol }
>()("Team.PrincipalNotFound", {}) {}
class OwnerRoleImmutable extends Schema.TaggedError<
  OwnerRoleImmutable,
  { readonly brand: unique symbol }
>()("Team.OwnerRoleImmutable", {}) {}

export interface TeamsService {
  readonly memberTeamIds: (
    principal: Principal,
  ) => Effect.Effect<ReadonlyArray<string>, DatabaseError>;
  readonly isMember: (
    principal: Principal,
    teamId: string,
  ) => Effect.Effect<boolean, DatabaseError>;
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
    const random = yield* SecureRandom.SecureRandom;
    const clock = yield* Clock.Clock;
    const db = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(databaseError(operation));

    const memberTeamIds = Effect.fn("Teams.memberTeamIds")(function* (principal: Principal) {
      const rows = yield* db(
        "read team memberships",
        sql`SELECT team_id FROM team_memberships WHERE principal_id = ${principal.id}`,
      );
      const memberships = yield* Schema.decodeUnknownEffect(Schema.Array(TeamIdRow))(rows).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode team memberships", cause }),
        ),
      );
      return memberships.map(({ team_id }) => team_id);
    });

    const isMember = Effect.fn("Teams.isMember")(function* (principal: Principal, teamId: string) {
      const rows = yield* db(
        "check team membership",
        sql`SELECT 1 member FROM team_memberships
          WHERE team_id = ${teamId} AND principal_id = ${principal.id} LIMIT 1`,
      );
      return rows.length !== 0;
    });

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
      const teamId = `team_${(yield* random.uuidV4()).replaceAll("-", "")}`;
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      const namespace = prepareTeamNamespaceClaim(sql, { namespace: slug, teamId, createdAt: now });
      const committed = yield* db(
        "create team",
        sql.batch([
          sql`INSERT INTO teams (team_id, slug, name, created_at)
            VALUES (${teamId}, ${slug}, ${name}, ${now})`,
          sql`INSERT INTO team_memberships (team_id, principal_id, role, created_at)
            VALUES (${teamId}, ${principal.id}, 'owner', ${now})`,
          namespace.statement,
        ]),
      ).pipe(Effect.result);
      if (committed._tag === "Failure") {
        const [teamExists, namespaceTaken] = yield* Effect.all([
          db(
            "check team conflict",
            sql`SELECT 1 found FROM teams WHERE slug = ${slug} LIMIT 1`,
          ).pipe(Effect.map((rows) => rows.length !== 0)),
          namespace.isTaken,
        ]);
        if (teamExists || namespaceTaken) return yield* new TeamConflict();
        return yield* committed.failure;
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
      const now = new Date(yield* clock.currentTimeMillis).toISOString();
      // Guard the owner role inside the write, so no role change after the reads above can
      // let it demote an owner.
      const added = yield* db(
        "add team member",
        sql`INSERT INTO team_memberships (team_id, principal_id, role, created_at)
            VALUES (${team.team_id}, ${member.principal_id}, 'member', ${now})
            ON CONFLICT(team_id, principal_id) DO UPDATE SET role = excluded.role
            WHERE team_memberships.role <> 'owner'
            RETURNING role`,
      );
      if (added.length === 0) return yield* new OwnerRoleImmutable();
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

    return Teams.of({ memberTeamIds, isMember, create, addMember, removeMember });
  }),
);
