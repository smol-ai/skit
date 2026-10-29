import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import {
  InvalidRequestResponse,
  RateLimitedResponse,
  StorageFailureResponse,
  UnauthorizedResponse,
} from "./errors.js";

const shortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * What an agent sends about friction with SKIT itself. The CLI fills in the platform and runtime;
 * the server reads the CLI's version from the `skit-client` header every request already carries.
 * Later fields are added as optional keys, and the server ignores keys it does not know.
 *
 * A report is anonymous unless the user opts in. `email` is a contact address the user chose to
 * give, stored unverified. Signing a report carries no field: it is a Bearer token, and the server
 * records the account that token belongs to.
 */
export const FeedbackInput = Schema.Struct({
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  harness: Schema.optionalKey(shortText),
  model: Schema.optionalKey(shortText),
  email: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
  ),
  platform: shortText,
  runtime: shortText,
});
export interface FeedbackInput extends Schema.Schema.Type<typeof FeedbackInput> {}

export const FeedbackResult = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
});
export interface FeedbackResult extends Schema.Schema.Type<typeof FeedbackResult> {}

export class FeedbackGroup extends HttpApiGroup.make("feedback").add(
  HttpApiEndpoint.post("send", "/api/feedback", {
    payload: FeedbackInput,
    success: FeedbackResult.pipe(HttpApiSchema.status(201)),
    error: [
      InvalidRequestResponse,
      UnauthorizedResponse,
      RateLimitedResponse,
      StorageFailureResponse,
    ],
  }),
) {}
export class FeedbackApi extends HttpApi.make("skit-feedback-api").add(FeedbackGroup) {}
