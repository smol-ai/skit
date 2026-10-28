import { Effect } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { FeedbackApi, FeedbackInput } from "@smolai/skit-core/universal/api";
import { Feedback } from "../feedback/service.js";
import { FeedbackRateLimiter } from "../platform/rate-limiter.js";
import { invalidRequestResponse, rateLimitedResponse, storageFailureResponse } from "./errors.js";
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
        return yield* feedback
          .record({ ...input, client: request.headers["skit-client"]?.slice(0, MAX_CLIENT_LENGTH) })
          .pipe(
            Effect.tapError((error) => Effect.logError("feedback record failed", error)),
            Effect.mapError(() => storageFailureResponse),
            Effect.tap(() => noStore),
          );
      }),
    );
  }),
);
