import { Config, Data, Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { FeedbackApi, FeedbackInput } from "@smolai/skit-core/universal/api";
import { officialRegistryOrigin, parseOrigin } from "../registry/accounts.js";
import { registryApiFailure, registryApiFailureMessage } from "../registry/api-client.js";
import { resolveAuth } from "../registry/auth.js";
import { isRegistryTransportError, RegistryHttp } from "../registry/registry-http.js";

export class FeedbackInputInvalid
  extends Data.TaggedError("FeedbackInputInvalid")<{ readonly message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    'Pass one message, either as an argument or with --message: skit feedback send "what slowed you down".';
}

export class FeedbackNotSent
  extends Data.TaggedError("FeedbackNotSent")<{ readonly message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Nothing was sent. Retry the same command; feedback is not saved for later.";
}

export class FeedbackSignInRequired
  extends Data.TaggedError("FeedbackSignInRequired")<{
    readonly message: string;
    readonly origin: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "AUTHENTICATION_REQUIRED" as const;
  get remediation() {
    const login =
      this.origin === officialRegistryOrigin ? "skit auth login" : `skit auth login ${this.origin}`;
    return `Nothing was sent. Ask the user to run \`${login}\`, or send without --signed-in.`;
  }
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
  const { token } = yield* resolveAuth(home, origin);
  if (token === undefined)
    return yield* new FeedbackSignInRequired({
      message: `This machine is not signed in to ${origin}.`,
      origin,
    });
  return token;
});

/** One report from the command's arguments, plus the platform and runtime this CLI runs on. */
export const feedbackInput = Effect.fnUntraced(function* (options: {
  readonly text: string | undefined;
  readonly message: string | undefined;
  readonly harness: string | undefined;
  readonly model: string | undefined;
  readonly email: string | undefined;
}) {
  const text = options.text?.trim() || undefined;
  const message = options.message?.trim() || undefined;
  if (text !== undefined && message !== undefined)
    return yield* new FeedbackInputInvalid({
      message: "Feedback was given both as an argument and with --message.",
    });
  const harness = options.harness?.trim() || undefined;
  const model = options.model?.trim() || undefined;
  const email = options.email?.trim() || undefined;
  return yield* Schema.decodeUnknownEffect(FeedbackInput)({
    message: text ?? message ?? "",
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(email === undefined ? {} : { email }),
    platform: process.platform,
    runtime: process.version,
  }).pipe(
    Effect.mapError(
      () =>
        new FeedbackInputInvalid({
          message:
            "Feedback needs a message of 1 to 10,000 characters; --harness and --model take up to 200, and --email one address.",
        }),
    ),
  );
});

/**
 * Send one report. It is sent once or not at all: nothing retries, and nothing is kept to resend.
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
        ? new FeedbackNotSent({ message: `Could not reach ${origin}: ${error.message}` })
        : registryApiFailure(error).code === "unauthorized"
          ? new FeedbackSignInRequired({
              message: `${origin} did not accept this machine's sign-in.`,
              origin,
            })
          : new FeedbackNotSent({
              message: registryApiFailureMessage(`Sending feedback to ${origin}`, error),
            }),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(
          new FeedbackNotSent({ message: `${origin} did not answer within 10 seconds.` }),
        ),
    }),
  );
});
