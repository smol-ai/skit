import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Identity } from "../identity/service.js";
import type { RateLimiter } from "../platform/rate-limiter.js";
import { CurrentPrincipal } from "./authentication.js";
import { ConsumerAuthenticatedApi } from "@smolai/skit-core/universal/api";
import {
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

export const tokenHandlers = (rateLimiter: RateLimiter) =>
  HttpApiBuilder.group(ConsumerAuthenticatedApi, "tokens", (handlers) =>
    Effect.gen(function* () {
      const authentication = yield* Identity;

      return handlers.handleAll({
        create: ({ payload }) =>
          Effect.gen(function* () {
            const principal = yield* CurrentPrincipal;
            if (principal.credential !== "session")
              return yield* Effect.fail(sessionRequiredResponse);

            const outcome = yield* rateLimiter.limit(principal.id).pipe(
              Effect.tapError((error) => Effect.logError("token rate limit failed", error)),
              Effect.catchTag("Cloudflare.RateLimitError", () =>
                Effect.fail(storageFailureResponse),
              ),
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
