import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Authentication } from "../auth/authentication.js";
import { credentialOriginAllowed } from "../auth/request-context.js";
import { ServerConfiguration } from "../configuration.js";
import { PatRateLimiter } from "../platform/rate-limiter.js";
import { CurrentPrincipal, CurrentRequest } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "./authenticated.js";
import {
  forbiddenOriginResponse,
  invalidExpiryResponse,
  invalidScopeResponse,
  rateLimitedResponse,
  sessionRequiredResponse,
  storageFailureResponse,
  tokenNotFoundResponse,
  unauthorizedPrincipalResponse,
} from "./errors.js";

const retryAfter = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", "60")),
);

export const tokenHandlers = HttpApiBuilder.group(ConsumerAuthenticatedApi, "tokens", (handlers) =>
  Effect.gen(function* () {
    const authentication = yield* Authentication;
    const configuration = yield* ServerConfiguration;
    const rateLimiter = yield* PatRateLimiter;

    return handlers.handleAll({
      create: ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (principal.credential !== "session")
            return yield* Effect.fail(sessionRequiredResponse);
          const request = yield* CurrentRequest;
          if (
            !credentialOriginAllowed(principal.credential, request, configuration.publicAppOrigin)
          )
            return yield* Effect.fail(forbiddenOriginResponse);

          const outcome = yield* rateLimiter.limit(principal.id).pipe(
            Effect.tapError((error) => Effect.logError("token rate limit failed", error)),
            Effect.catchTag("Cloudflare.RateLimitError", () => Effect.fail(storageFailureResponse)),
          );
          if (!outcome.success) {
            yield* retryAfter;
            return yield* Effect.fail(rateLimitedResponse);
          }

          return yield* authentication
            .createPat(principal, {
              name: payload.name,
              scopes: payload.scopes,
              expiresAt: payload.expires_at,
            })
            .pipe(
              Effect.catchTags({
                "Authentication.InvalidScope": () => Effect.fail(invalidScopeResponse),
                "Authentication.InvalidExpiry": () => Effect.fail(invalidExpiryResponse),
                "Authentication.SessionRequired": () => Effect.fail(sessionRequiredResponse),
                "Authentication.UnauthorizedPrincipal": () =>
                  Effect.fail(unauthorizedPrincipalResponse),
                "Authentication.CryptoError": (error) =>
                  Effect.logError("token creation crypto failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
                "Cloudflare.DatabaseError": (error) =>
                  Effect.logError("token creation storage failed", error).pipe(
                    Effect.andThen(Effect.fail(storageFailureResponse)),
                  ),
              }),
            );
        }),
      list: () =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (principal.credential !== "session")
            return yield* Effect.fail(sessionRequiredResponse);
          const tokens = yield* authentication.listPats(principal).pipe(
            Effect.catchTags({
              "Authentication.SessionRequired": () => Effect.fail(sessionRequiredResponse),
              "Cloudflare.DatabaseError": (error) =>
                Effect.logError("token list failed", error).pipe(
                  Effect.andThen(Effect.fail(storageFailureResponse)),
                ),
            }),
          );
          return { tokens };
        }),
      revoke: ({ params }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          const request = yield* CurrentRequest;
          if (
            !credentialOriginAllowed(principal.credential, request, configuration.publicAppOrigin)
          )
            return yield* Effect.fail(forbiddenOriginResponse);
          const revoked = yield* authentication.revokePat(principal, params.token_id).pipe(
            Effect.catchTags({
              "Authentication.SessionRequired": () => Effect.fail(sessionRequiredResponse),
              "Cloudflare.DatabaseError": (error) =>
                Effect.logError("token revocation failed", error).pipe(
                  Effect.andThen(Effect.fail(storageFailureResponse)),
                ),
            }),
          );
          if (!revoked) return yield* Effect.fail(tokenNotFoundResponse);
        }),
    });
  }),
);
