import { Config, Effect, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { FeedbackNotSent, FeedbackUnconfirmed } from "../feedback/failures.js";
import { FeedbackApi, FeedbackInput } from "@smolai/skit-core/api";
import { officialRegistryOrigin, parseOrigin } from "./accounts.js";
import {
  registryApiFailure,
  classifyRegistryApiFailure,
  markRegistryResponseDecoding,
} from "./api-client.js";
import { Registry } from "./index.js";
import { AuthenticationRequired } from "./failures.js";
import { RegistryHttp } from "./registry-http.js";

/**
 * Where feedback goes: SKIT's maintainers, whichever Registry this machine uses. Only
 * `SKIT_FEEDBACK_URL` changes it, for testing against another server.
 */
export const feedbackOrigin = Effect.gen(function* () {
  const configured = yield* Config.option(Config.String("SKIT_FEEDBACK_URL"));
  return yield* parseOrigin(Option.getOrElse(configured, () => officialRegistryOrigin));
});

/**
 * The token that signs a report: this machine's credential for `origin` and no other, since a
 * token is only ever sent to the server that issued it.
 */
export const feedbackSigningToken = Effect.fn("Feedback.signingToken")(function* (
  origin: string,
  home: string,
) {
  const { token } = yield* Registry.credentials({ home, registry: origin });
  if (token === undefined) return yield* new AuthenticationRequired({ origin });
  return token;
});

/**
 * Send one report, once: nothing retries, and nothing is kept to resend. A refusal means the server
 * stored nothing; a lost connection or a timeout leaves that unknown, so it is not reported as
 * "not sent" and invites no resend.
 * With `token` the report is signed, and the server attributes it to that token's account.
 */
export const sendFeedback = Effect.fn("Feedback.send")(function* (
  origin: string,
  input: FeedbackInput,
  token?: string,
) {
  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(FeedbackApi, {
    transformResponse: markRegistryResponseDecoding,
    httpClient:
      token === undefined
        ? transport
        : HttpClient.mapRequest(transport, HttpClientRequest.bearerToken(token)),
    baseUrl: origin,
  });
  return yield* client.feedback.send({ payload: input }).pipe(
    Effect.mapError((error) => {
      const classified = classifyRegistryApiFailure(error, [200, 201, 202, 204]);
      if (classified.kind === "transport")
        return new FeedbackUnconfirmed({
          origin,
          reason: { _tag: "TransportFailed", failure: classified.error },
        });
      if (classified.kind === "response_decode")
        return new FeedbackUnconfirmed({
          origin,
          reason: { _tag: "ResponseInvalid", failure: classified.failure },
        });
      if (classified.kind === "request_encoding")
        return new FeedbackNotSent({
          reason: { _tag: "RequestInvalid", failure: classified.failure },
        });
      const failure = registryApiFailure(error);
      if (failure.code === "unauthorized") return new AuthenticationRequired({ origin });
      if (failure.status !== undefined && failure.status < 500 && failure.code !== undefined)
        return new FeedbackNotSent({ reason: { _tag: "Rejected", origin, ...failure } });
      return new FeedbackUnconfirmed({ origin, reason: { _tag: "ServerError", ...failure } });
    }),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new FeedbackUnconfirmed({ origin, reason: { _tag: "TimedOut", timeoutMs: 10_000 } }),
        ),
    }),
  );
});

export const submitFeedback = Effect.fn("Registry.submitFeedback")(function* (
  input: FeedbackInput,
  options: { readonly signedIn: boolean; readonly home: string },
) {
  const recipient = yield* feedbackOrigin;
  const token = options.signedIn ? yield* feedbackSigningToken(recipient, options.home) : undefined;
  const sent = yield* sendFeedback(recipient, input, token);
  return {
    ...sent,
    recipient,
    signedIn: options.signedIn,
    ...(input.email === undefined ? {} : { email: input.email }),
  };
});
