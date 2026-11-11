import { Effect, Schema } from "effect";
import { FeedbackInputInvalid } from "./failures.js";
import { FeedbackInput } from "@smolai/skit-core/api";

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
      reason: { _tag: "ConflictingMessages" },
    });
  const harness = options.harness?.trim() || undefined;
  const model = options.model?.trim() || undefined;
  const email = options.email?.trim() || undefined;
  return yield* Schema.decodeEffect(FeedbackInput, { errors: "all" })({
    message: text ?? message ?? "",
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined ? {} : { model }),
    ...(email === undefined ? {} : { email }),
    platform: process.platform,
    runtime: process.version,
  }).pipe(
    Effect.mapError(
      (failure) => new FeedbackInputInvalid({ reason: { _tag: "InvalidData", failure } }),
    ),
  );
});
