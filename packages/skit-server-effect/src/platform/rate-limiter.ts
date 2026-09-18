import { Context, Effect, Layer } from "effect";
import { RateLimitError, rateLimitEffect } from "./cloudflare.js";

export interface RateLimiterService {
  readonly limit: (key: string) => Effect.Effect<{ readonly success: boolean }, RateLimitError>;
}

export class PatRateLimiter extends Context.Service<PatRateLimiter, RateLimiterService>()(
  "@skit-server-effect/PatRateLimiter",
) {}

export class BootstrapRateLimiter extends Context.Service<
  BootstrapRateLimiter,
  RateLimiterService
>()("@skit-server-effect/BootstrapRateLimiter") {}

export const patLayer = (binding: RateLimit) =>
  Layer.succeed(PatRateLimiter, {
    limit: (key) => rateLimitEffect(binding, key),
  });

export const bootstrapLayer = (binding: RateLimit) =>
  Layer.succeed(BootstrapRateLimiter, {
    limit: (key) => rateLimitEffect(binding, key),
  });
