import { Config, Data, Effect, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { FeedbackApi, FeedbackInput } from "@smolai/skit-core/api";
import { officialRegistryOrigin, parseOrigin } from "./accounts.js";
import { registryApiFailure, registryApiFailureMessage } from "./api-client.js";
import { Registry } from "./index.js";
import { AuthenticationRequired } from "./failures.js";
import { isRegistryTransportError, RegistryHttp } from "./registry-http.js";

class FeedbackNotSent
  extends Data.TaggedError("FeedbackNotSent")<{ readonly message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Nothing was sent. Retry the same command; feedback is not saved for later.";
}

class FeedbackUnconfirmed
  extends Data.TaggedError("FeedbackUnconfirmed")<{ readonly message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "The report may have arrived. Do not send it again; carry on with the task.";
}

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
    httpClient:
      token === undefined
        ? transport
        : HttpClient.mapRequest(transport, HttpClientRequest.bearerToken(token)),
    baseUrl: origin,
  });
  return yield* client.feedback.send({ payload: input }).pipe(
    Effect.mapError((error) =>
      isRegistryTransportError(error)
        ? new FeedbackUnconfirmed({ message: `Lost contact with ${origin}: ${error.message}` })
        : registryApiFailure(error).code === "unauthorized"
          ? new AuthenticationRequired({ origin })
          : new FeedbackNotSent({
              message: registryApiFailureMessage(`Sending feedback to ${origin}`, error),
            }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new FeedbackUnconfirmed({ message: `${origin} did not answer within 10 seconds.` }),
        ),
    }),
  );
});

// Required to name inferred command errors in generated declarations.
export type { FeedbackNotSent, FeedbackUnconfirmed };

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
