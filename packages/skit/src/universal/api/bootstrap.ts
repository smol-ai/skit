import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
  ForbiddenOriginResponse,
  InvalidRequestResponse,
  RateLimitedResponse,
  StorageFailureResponse,
  UnauthorizedResponse,
} from "./errors.js";

export const BootstrapInput = Schema.Struct({
  token: Schema.String,
  username: Schema.String,
  email: Schema.String,
  password: Schema.String,
});
export interface BootstrapInput extends Schema.Schema.Type<typeof BootstrapInput> {}
export const BootstrapResult = Schema.Struct({
  email: Schema.String,
  username: Schema.String,
  verificationEmailSent: Schema.Boolean,
});
export interface BootstrapResult extends Schema.Schema.Type<typeof BootstrapResult> {}
export const BootstrapStatus = Schema.Struct({ needed: Schema.Boolean });
export const BootstrapCompleteResponse = Schema.Struct({
  error: Schema.Literal("bootstrap_complete"),
}).pipe(HttpApiSchema.status(409));
export class BootstrapGroup extends HttpApiGroup.make("bootstrap").add(
  HttpApiEndpoint.get("status", "/api/bootstrap/status", {
    success: BootstrapStatus,
    error: StorageFailureResponse,
  }),
  HttpApiEndpoint.post("create", "/api/bootstrap", {
    payload: BootstrapInput,
    success: BootstrapResult.pipe(HttpApiSchema.status(201)),
    error: [
      InvalidRequestResponse,
      ForbiddenOriginResponse,
      UnauthorizedResponse,
      RateLimitedResponse,
      BootstrapCompleteResponse,
      StorageFailureResponse,
    ],
  }),
) {}
export class BootstrapApi extends HttpApi.make("skit-bootstrap-api").add(BootstrapGroup) {}
