import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Teams } from "../teams/service.js";
import { CurrentPrincipal } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "@smolai/skit-core/universal/api";
import {
  invalidTeamResponse,
  membershipNotFoundResponse,
  ownerRoleImmutableResponse,
  principalNotFoundResponse,
  sessionRequiredResponse,
  storageFailureResponse,
  teamConflictResponse,
  teamForbiddenResponse,
  teamSessionRequiredResponse,
} from "./errors.js";

export const teamHandlers = HttpApiBuilder.group(ConsumerAuthenticatedApi, "teams", (handlers) =>
  Effect.gen(function* () {
    const teams = yield* Teams;
    const requireSession = Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      if (principal.credential !== "session") return yield* Effect.fail(sessionRequiredResponse);
      return principal;
    });

    return handlers.handleAll({
      create: ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireSession;
          const team = yield* teams.create(principal, payload).pipe(
            Effect.catchTags({
              "Team.SessionRequired": () => Effect.fail(teamSessionRequiredResponse),
              "Team.Invalid": () => Effect.fail(invalidTeamResponse),
              "Team.Conflict": () => Effect.fail(teamConflictResponse),
              "Cloudflare.DatabaseError": (error) =>
                Effect.logError("team creation storage failed", error).pipe(
                  Effect.andThen(Effect.fail(storageFailureResponse)),
                ),
            }),
          );
          return { team };
        }),
      addMember: ({ params, payload }) =>
        Effect.gen(function* () {
          const principal = yield* requireSession;
          const member = yield* teams.addMember(principal, params.slug, payload.email).pipe(
            Effect.catchTags({
              "Team.SessionRequired": () => Effect.fail(teamSessionRequiredResponse),
              "Team.Forbidden": () => Effect.fail(teamForbiddenResponse),
              "Team.PrincipalNotFound": () => Effect.fail(principalNotFoundResponse),
              "Team.OwnerRoleImmutable": () => Effect.fail(ownerRoleImmutableResponse),
              "Cloudflare.DatabaseError": (error) =>
                Effect.logError("team member storage failed", error).pipe(
                  Effect.andThen(Effect.fail(storageFailureResponse)),
                ),
            }),
          );
          return { member };
        }),
      removeMember: ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* requireSession;
          const removed = yield* teams
            .removeMember(principal, params.slug, params.principal_id)
            .pipe(
              Effect.catchTags({
                "Team.SessionRequired": () => Effect.fail(teamSessionRequiredResponse),
                "Team.Forbidden": () => Effect.fail(teamForbiddenResponse),
                "Cloudflare.DatabaseError": (error) =>
                  Effect.logError("team removal storage failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
              }),
            );
          if (!removed) return yield* Effect.fail(membershipNotFoundResponse);
        }),
    });
  }),
);
