import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authorization } from "../authorization/service.js";
import { ServerConfiguration } from "../configuration.js";
import { SkitDeletion } from "../skit-delete/service.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { AuthoringAuthenticatedApi } from "./authenticated.js";
import {
  deleteRequiresPrivateResponse,
  forbiddenOriginResponse,
  insufficientScopeResponse,
  skitNotFoundResponse,
  storageFailureResponse,
} from "./errors.js";
import { noStore } from "./response.js";

export const skitDeleteHandlers = HttpApiBuilder.group(
  AuthoringAuthenticatedApi,
  "skitDelete",
  (handlers) =>
    Effect.gen(function* () {
      const authorization = yield* Authorization;
      const deletion = yield* SkitDeletion;
      const configuration = yield* ServerConfiguration;

      return handlers.handle("deletePrivate", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (!principal.scopes.has("authoring:write"))
            return yield* Effect.fail(insufficientScopeResponse);

          const request = yield* CurrentRequest;
          if (
            principal.credential === "session" &&
            request.headers.get("origin") !== configuration.publicAppOrigin
          )
            return yield* Effect.fail(forbiddenOriginResponse);

          const permitted = yield* authorization
            .canDeleteSkit(principal, params.owner, params.slug)
            .pipe(
              Effect.tapError((error) =>
                Effect.logError("SKIT deletion authorization failed", error),
              ),
              Effect.catchTag("Cloudflare.DatabaseError", () =>
                Effect.fail(storageFailureResponse),
              ),
            );
          if (!permitted) return yield* Effect.fail(skitNotFoundResponse);

          const operation =
            query.dry_run === "true"
              ? deletion.plan(params.owner, params.slug).pipe(
                  Effect.map((plan) =>
                    plan === undefined
                      ? {
                          status: "absent" as const,
                          skit_id: `${params.owner}/${params.slug}`,
                          changed: false,
                          draft_revisions: 0,
                          releases: 0,
                          release_versions: [],
                        }
                      : { status: "delete_ready" as const, changed: false, ...plan },
                  ),
                )
              : deletion.delete(params.owner, params.slug);

          const result = yield* operation.pipe(
            Effect.tapError((error) => Effect.logError("SKIT deletion failed", error)),
            Effect.catchTags({
              "SkitDelete.RequiresPrivate": () => Effect.fail(deleteRequiresPrivateResponse),
              "Cloudflare.DatabaseError": () => Effect.fail(storageFailureResponse),
            }),
          );
          yield* noStore;
          return result;
        }),
      );
    }),
);
