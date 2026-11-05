import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Skits } from "../skits/service.js";
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
      const skits = yield* Skits;

      return handlers.handle("deletePrivate", ({ params, query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (!principal.scopes.has("authoring:write"))
            return yield* Effect.fail(insufficientScopeResponse);

          const operation =
            query.dry_run === "true"
              ? skits.planDelete(principal, params.owner, params.slug).pipe(
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
              : skits.delete(principal, params.owner, params.slug);

          const result = yield* operation.pipe(
            Effect.tapError((error) => Effect.logError("SKIT deletion failed", error)),
            Effect.catchTags({
              "SkitDelete.NotFound": () => Effect.fail(skitNotFoundResponse),
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
