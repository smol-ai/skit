import { HttpServerRequest } from "effect/http";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { inspectReadiness } from "../platform/readiness.js";
import { isServerOperator } from "../identity/service.js";
import type { RuntimeEnv } from "../platform/cloudflare.js";
import { CurrentPrincipal } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "@smolai/skit-core/api";
import { forbiddenResponse, sessionRequiredResponse, storageFailureResponse } from "./errors.js";
import { noStore } from "./response.js";

export const readinessHandlers = (env: RuntimeEnv) =>
  HttpApiBuilder.group(ConsumerAuthenticatedApi, "readiness", (handlers) =>
    handlers.handle("inspect", () =>
      Effect.gen(function* () {
        const principal = yield* CurrentPrincipal;
        if (principal.credential !== "session") return yield* Effect.fail(sessionRequiredResponse);

        const operator = yield* isServerOperator(principal).pipe(
          Effect.tapError((error) => Effect.logError("operator lookup failed", error)),
          Effect.catchTag("Cloudflare.DatabaseError", () => Effect.fail(storageFailureResponse)),
        );
        if (!operator) return yield* Effect.fail(forbiddenResponse);

        const request = yield* HttpServerRequest.HttpServerRequest;
        const readiness = yield* inspectReadiness(env, new URL(request.originalUrl).origin);
        yield* noStore;
        return { schema: "skit.server.readiness.v1" as const, ...readiness };
      }),
    ),
  );
