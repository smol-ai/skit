import { Data, Effect, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core/shared";
import { FeedbackInput } from "@smolai/skit-core/universal/api";

class FeedbackInputInvalid
  extends Data.TaggedError("FeedbackInputInvalid")<{ readonly message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "INVALID_ARGUMENT" as const;
  readonly remediation =
    'Pass one message, either as an argument or with --message: skit feedback send "what slowed you down".';
}

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
            "Feedback needs a message of 1 to 1,000 characters; --harness and --model take up to 200, and --email one address.",
        }),
    ),
  );
});

export type { FeedbackInputInvalid };
