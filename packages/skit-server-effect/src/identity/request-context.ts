import { Effect, Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { Identity } from "./service.js";

export class RequestConversionError extends Schema.TaggedError<RequestConversionError>()(
  "Authentication.RequestConversionError",
  { cause: Schema.Defect() },
) {}

export const authenticateRequest = Effect.fn("Authentication.authenticateRequest")(function* () {
  const authentication = yield* Identity;
  const request = yield* HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap(HttpServerRequest.toWeb),
    Effect.mapError((cause) => new RequestConversionError({ cause })),
  );
  return { request, principal: yield* authentication.authenticate(request) };
});
