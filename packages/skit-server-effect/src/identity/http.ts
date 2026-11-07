import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { schemaBodyJsonLimited } from "../api/request-body.js";
import { ServerConfiguration } from "../platform/configuration.js";
import { makeRateLimiter } from "../platform/rate-limiter.js";
import type { RuntimeEnv } from "../platform/cloudflare.js";
import { Identity } from "./service.js";
const MAX_USERNAME_REQUEST_BYTES = 4 * 1024;
const UsernameClaimInput = Schema.Struct({ username: Schema.String });
const storageFailure = HttpServerResponse.json(
  { error: "storage_failure" },
  { status: 500, headers: { "cache-control": "no-store" } },
).pipe(Effect.orDie);

export const handleRequest = Effect.fn("BetterAuthHttp.handleRequest")(function* (env: RuntimeEnv) {
  const betterAuth = yield* Identity;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.tapError((error) => Effect.logError("authentication request conversion failed", error)),
    Effect.catch(() => storageFailure),
  );
  if (HttpServerResponse.isHttpServerResponse(webRequest)) return webRequest;

  const pathname = new URL(webRequest.url).pathname;
  if (
    webRequest.method === "POST" &&
    [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/send-verification-email",
      "/api/auth/device/code",
    ].includes(pathname)
  ) {
    const clientIp = webRequest.headers.get("cf-connecting-ip") ?? "unknown";
    const outcome = yield* makeRateLimiter(env.AUTH_RATE_LIMITER)
      .limit(`${pathname}:${clientIp}`)
      .pipe(
        Effect.tapError((error) => Effect.logError("authentication rate limit failed", error)),
        Effect.catchTag("Cloudflare.RateLimitError", () => Effect.undefined),
      );
    if (outcome === undefined) return yield* storageFailure;
    if (!outcome.success)
      return yield* HttpServerResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        },
      ).pipe(Effect.orDie);
  }

  return yield* betterAuth.handle(webRequest).pipe(
    Effect.map(HttpServerResponse.fromWeb),
    Effect.tapError((error) => Effect.logError("authentication failed", error)),
    Effect.catchTag("BetterAuth.AdapterError", () => storageFailure),
  );
});

export const handleUsernameClaim = Effect.fn("BetterAuthHttp.handleUsernameClaim")(function* () {
  const betterAuth = yield* Identity;
  const configuration = yield* ServerConfiguration;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.catch(() => Effect.undefined),
  );
  if (webRequest === undefined)
    return yield* HttpServerResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  if (webRequest.headers.get("origin") !== configuration.publicAppOrigin)
    return yield* HttpServerResponse.json(
      { error: "forbidden_origin" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  const session = yield* betterAuth
    .authenticateSession(webRequest.headers)
    .pipe(Effect.catchTag("BetterAuth.AdapterError", () => Effect.undefined));
  if (session === undefined)
    return yield* HttpServerResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  const input = yield* schemaBodyJsonLimited(
    request,
    UsernameClaimInput,
    MAX_USERNAME_REQUEST_BYTES,
  ).pipe(Effect.option);
  if (Option.isNone(input))
    return yield* HttpServerResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  const result = yield* betterAuth
    .claimUsername(session.userId, input.value.username)
    .pipe(Effect.result);
  if (result._tag === "Failure") {
    if (result.failure._tag === "BetterAuth.InvalidUsername")
      return yield* HttpServerResponse.json(
        { error: "invalid_username" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    if (result.failure._tag === "BetterAuth.UsernameUnavailable")
      return yield* HttpServerResponse.json(
        { error: "username_unavailable" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    yield* Effect.logError("username claim failed", result.failure);
    return yield* HttpServerResponse.json(
      { error: "storage_failure" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
  return yield* HttpServerResponse.json(
    { username: result.success },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});

export const handleProvisionedUsername = Effect.fn("BetterAuthHttp.handleProvisionedUsername")(
  function* () {
    const betterAuth = yield* Identity;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* betterAuth
      .authenticateSession(new Headers(request.headers))
      .pipe(Effect.catchTag("BetterAuth.AdapterError", () => Effect.undefined));
    if (session === undefined)
      return yield* HttpServerResponse.json(
        { error: "unauthorized" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    const username = yield* betterAuth.provisionedUsername(session.userId).pipe(Effect.result);
    if (username._tag === "Failure") {
      yield* Effect.logError("provisioned username read failed", username.failure);
      return yield* HttpServerResponse.json(
        { error: "storage_failure" },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    return yield* HttpServerResponse.json(
      { username: username.success },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
