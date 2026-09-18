import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Bootstrap, BootstrapInput, type CreateError } from "../bootstrap/service.js";
import { BetterAuth } from "../auth/better-auth.js";
import { ServerConfiguration } from "../configuration.js";
import { BootstrapRateLimiter } from "../platform/rate-limiter.js";
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

export const bootstrapHandlers = HttpApiBuilder.group(BootstrapApi, "bootstrap", (handlers) =>
  Effect.gen(function* () {
    const bootstrap = yield* Bootstrap;
    const authentication = yield* BetterAuth;
    const configuration = yield* ServerConfiguration;
    const rateLimiter = yield* BootstrapRateLimiter;

    return handlers
      .handle("status", () =>
        bootstrap.isNeeded().pipe(
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
          return yield* bootstrap.createInitialOperator(input).pipe(
            Effect.tapError((error) =>
              error._tag === "Bootstrap.SecretComparisonError" ||
              error._tag === "PasswordHasher.PasswordHashError" ||
              error._tag === "Cloudflare.DatabaseError"
                ? Effect.logError("bootstrap creation failed", error)
                : Effect.void,
            ),
            Effect.mapError(mapCreateError),
            Effect.flatMap(({ email, username }) =>
              authentication.sendVerificationEmail(email).pipe(
                Effect.tapError((error) =>
                  Effect.logError("bootstrap verification email failed", error),
                ),
                Effect.match({
                  onFailure: () => ({ email, username, verificationEmailSent: false }),
                  onSuccess: (verificationEmailSent) => ({
                    email,
                    username,
                    verificationEmailSent,
                  }),
                }),
              ),
            ),
            Effect.tap(() => noStore),
          );
        }),
      );
  }),
);
