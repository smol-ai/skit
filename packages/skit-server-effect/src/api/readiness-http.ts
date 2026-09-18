import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ReadinessInspector } from "../readiness/service.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "./authenticated.js";
import { forbiddenResponse, sessionRequiredResponse, storageFailureResponse } from "./errors.js";
import { noStore } from "./response.js";

export const readinessHandlers = HttpApiBuilder.group(
  ConsumerAuthenticatedApi,
  "readiness",
  (handlers) =>
    Effect.gen(function* () {
      const inspector = yield* ReadinessInspector;
      return handlers.handle("inspect", () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (principal.credential !== "session")
            return yield* Effect.fail(sessionRequiredResponse);

          const operator = yield* inspector.isServerOperator(principal).pipe(
            Effect.tapError((error) => Effect.logError("operator lookup failed", error)),
            Effect.catchTag("Cloudflare.DatabaseError", () => Effect.fail(storageFailureResponse)),
          );
          if (!operator) return yield* Effect.fail(forbiddenResponse);

          const request = yield* CurrentRequest;
          const readiness = yield* inspector.inspect(new URL(request.url).origin);
          yield* noStore;
          return { schema: "skit.server.readiness.v1" as const, ...readiness };
        }),
      );
    }),
);
