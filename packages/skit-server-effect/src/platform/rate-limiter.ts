import { Effect, Schema } from "effect";

class RateLimitError extends Schema.TaggedError<RateLimitError>()("Cloudflare.RateLimitError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A bound Cloudflare limiter; independent policies keep independent binding instances. */
export interface RateLimiter {
  readonly limit: (key: string) => Effect.Effect<{ readonly success: boolean }, RateLimitError>;
}

export const makeRateLimiter = (binding: RateLimit): RateLimiter => ({
  limit: (key) =>
    // oxlint-disable-next-line skit/no-promise-wrappers -- Wrangler's generated RateLimit binding is Promise-only; this platform module owns that SDK boundary.
    Effect.tryPromise({
      try: () => binding.limit({ key }),
      catch: (cause) => new RateLimitError({ operation: "limit request", cause }),
    }),
});
