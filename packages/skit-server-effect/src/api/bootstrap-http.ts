import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Identity, BootstrapInput, type CreateError } from "../identity/service.js";
import { ServerConfiguration } from "../platform/configuration.js";
import type { RateLimiter } from "../platform/rate-limiter.js";
import { BootstrapApi } from "./bootstrap.js";
import {
  forbiddenOriginResponse,
  invalidRequestResponse,
  rateLimitedResponse,
  storageFailureResponse,
  unauthorizedResponse,
} from "./errors.js";
import { schemaBodyJsonLimited } from "./request-body.js";
import { noStore } from "./response.js";

const MAX_BOOTSTRAP_REQUEST_BYTES = 16 * 1024;
const bootstrapComplete = { error: "bootstrap_complete" as const };
const retryAfter = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", "60")),
);

const mapCreateError = (error: CreateError) => {
  switch (error._tag) {
    case "Bootstrap.InvalidSecret":
      return unauthorizedResponse;
    case "Bootstrap.InvalidInput":
      return invalidRequestResponse;
    case "Bootstrap.Complete":
    case "Bootstrap.Unavailable":
      return bootstrapComplete;
    default:
      return storageFailureResponse;
  }
};

export const bootstrapHandlers = (rateLimiter: RateLimiter) =>
  HttpApiBuilder.group(BootstrapApi, "bootstrap", (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* Identity;
      const configuration = yield* ServerConfiguration;

      return handlers
        .handle("status", () =>
          authentication.isBootstrapNeeded.pipe(
            Effect.tapError((error) => Effect.logError("bootstrap status failed", error)),
            Effect.mapError(() => storageFailureResponse),
            Effect.tap(() => noStore),
            Effect.map((needed) => ({ needed })),
          ),
        )
        .handleRaw("create", ({ request }) =>
          Effect.gen(function* () {
            if (request.headers.origin !== configuration.publicAppOrigin)
              return yield* Effect.fail(forbiddenOriginResponse);
            const clientIp = request.headers["cf-connecting-ip"] ?? "unknown";
            const outcome = yield* rateLimiter.limit(clientIp).pipe(
              Effect.tapError((error) => Effect.logError("bootstrap rate limit failed", error)),
              Effect.mapError(() => storageFailureResponse),
            );
            if (!outcome.success) {
              yield* retryAfter;
              return yield* Effect.fail(rateLimitedResponse);
            }
            const input = yield* schemaBodyJsonLimited(
              request,
              BootstrapInput,
              MAX_BOOTSTRAP_REQUEST_BYTES,
            ).pipe(Effect.mapError(() => invalidRequestResponse));
            return yield* authentication.createOperator(input).pipe(
              Effect.tapError((error) =>
                error._tag === "Bootstrap.SecretComparisonError" ||
                error._tag === "PasswordHasher.PasswordHashError" ||
                error._tag === "Cloudflare.DatabaseError"
                  ? Effect.logError("bootstrap creation failed", error)
                  : Effect.void,
              ),
              Effect.mapError(mapCreateError),
              Effect.tap(() => noStore),
            );
          }),
        );
    }),
  );
