import { Effect, Option } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { FeedbackApi, FeedbackInput } from "@smolai/skit-core/universal/api";
import { Authentication } from "../auth/authentication.js";
import { authenticateRequest } from "../auth/request-context.js";
import { Feedback } from "../feedback/service.js";
import { FeedbackRateLimiter } from "../platform/rate-limiter.js";
import {
  invalidRequestResponse,
  rateLimitedResponse,
  storageFailureResponse,
  unauthorizedResponse,
} from "./errors.js";
import { schemaBodyJsonLimited } from "./request-body.js";
import { noStore } from "./response.js";

const MAX_FEEDBACK_REQUEST_BYTES = 16 * 1024;
const MAX_CLIENT_LENGTH = 200;
const retryAfter = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "retry-after", "60")),
);

export const feedbackHandlers = HttpApiBuilder.group(FeedbackApi, "feedback", (handlers) =>
  Effect.gen(function* () {
    const feedback = yield* Feedback;
    const rateLimiter = yield* FeedbackRateLimiter;
    // Present only on a deployment with accounts. Without it a report can still be sent, but not
    // signed: there is no account to attribute it to.
    const authentication = yield* Effect.serviceOption(Authentication);

    // A report is signed only by an explicit Bearer token, never by a browser's session cookie, so
    // no page can attribute a report to whoever happens to be signed in. A token that does not
    // authenticate is refused rather than dropped: the sender asked for attribution.
    const signer = Effect.fn("Feedback.signer")(function* (authorization: string | undefined) {
      if (authorization === undefined) return undefined;
      if (!authorization.startsWith("Bearer ") || Option.isNone(authentication))
        return yield* Effect.fail(unauthorizedResponse);
      const { principal } = yield* authenticateRequest().pipe(
        Effect.provideService(Authentication, authentication.value),
        Effect.tapError((error) => Effect.logError("feedback authentication failed", error)),
        Effect.mapError(() => storageFailureResponse),
      );
      if (principal === undefined) return yield* Effect.fail(unauthorizedResponse);
      return principal.id;
    });

    return handlers.handleRaw("send", ({ request }) =>
      Effect.gen(function* () {
        const clientIp = request.headers["cf-connecting-ip"] ?? "unknown";
        const outcome = yield* rateLimiter.limit(clientIp).pipe(
          Effect.tapError((error) => Effect.logError("feedback rate limit failed", error)),
          Effect.mapError(() => storageFailureResponse),
        );
        if (!outcome.success) {
          yield* retryAfter;
          return yield* Effect.fail(rateLimitedResponse);
        }
        // Newer clients may send fields this server does not know yet; their reports still count.
        const input = yield* schemaBodyJsonLimited(
          request,
          FeedbackInput,
          MAX_FEEDBACK_REQUEST_BYTES,
          { onExcessProperty: "ignore" },
        ).pipe(Effect.mapError(() => invalidRequestResponse));
        const principalId = yield* signer(request.headers["authorization"]);
        return yield* feedback
          .record({
            ...input,
            client: request.headers["skit-client"]?.slice(0, MAX_CLIENT_LENGTH),
            principalId,
          })
          .pipe(
            Effect.tapError((error) => Effect.logError("feedback record failed", error)),
            Effect.mapError(() => storageFailureResponse),
            Effect.tap(() => noStore),
          );
      }),
    );
  }),
);
