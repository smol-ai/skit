import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Authorization } from "../authorization/service.js";
import { SkitDeletion } from "../skit-delete/service.js";
import { CurrentPrincipal } from "./authentication.js";
import { AuthoringAuthenticatedApi } from "@smolai/skit-core/universal/api";
import {
  deleteRequiresPrivateResponse,
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

      return handlers.handle("deletePrivate", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (!principal.scopes.has("authoring:write"))
            return yield* Effect.fail(insufficientScopeResponse);

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
                          revisions: 0,
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
