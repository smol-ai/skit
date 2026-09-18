import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import type { RuntimeEnv } from "../platform/cloudflare.js";
import { Authentication, type Principal } from "./authentication.js";

export class RequestConversionError extends Schema.TaggedError<RequestConversionError>()(
  "Authentication.RequestConversionError",
  { cause: Schema.Defect() },
) {}

export const authenticateRequest = Effect.fn("Authentication.authenticateRequest")(function* () {
  const authentication = yield* Authentication;
  const request = yield* HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap(HttpServerRequest.toWeb),
    Effect.mapError((cause) => new RequestConversionError({ cause })),
  );
  return { request, principal: yield* authentication.authenticate(request) };
});

export const sessionOriginAllowed = (env: RuntimeEnv, request: Request, principal: Principal) =>
  credentialOriginAllowed(
    principal.credential,
    request,
    URL.parse(env.PUBLIC_APP_ORIGIN ?? "invalid:")?.origin ?? "invalid:",
  );

export const credentialOriginAllowed = (
  credential: Principal["credential"],
  request: Request,
  publicAppOrigin: string,
) => credential !== "session" || request.headers.get("origin") === publicAppOrigin;
