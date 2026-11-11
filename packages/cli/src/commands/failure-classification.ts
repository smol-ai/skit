import type { CommandError } from "./error-output.js";
import { dataFailure } from "./data-failure.js";
import { errorMessage } from "@smolai/skit-core/shared";
import { isSkitFailure, type FailureCode } from "@smolai/skit-core/shared";
import { Cause, Schema } from "effect";
import { SetupStopped } from "@smolai/skit-core/library/setup";
import { setupStoppedFailure } from "../library/setup/failures.js";
import { describeFailure } from "../terminal/failure.js";
import { Block } from "../terminal/blocks.js";
import type { CommandFailure } from "./types.js";

export interface ClassifiedFailure extends CommandFailure {
  code: FailureCode;
}

/** Native causes explain the fallback; known owners still choose their own context and actions.
 * A depth limit bounds even a chain that creates a fresh cause on every access. */
const nativeCauseDetails = (error: unknown): readonly Block[] => {
  const seen = new Set<unknown>();
  const messages = new Set([errorMessage(error)]);
  const details: Block[] = [];
  let current = error;
  for (let depth = 0; depth < 16; depth++) {
    if (!(current instanceof Error) || current.cause === undefined) return details;
    seen.add(current);
    current = current.cause;
    if (seen.has(current)) return details;
    const formatted = dataFailure(current);
    const message = formatted?.message ?? errorMessage(current);
    if (!messages.has(message)) {
      messages.add(message);
      details.push(
        Block.Group({
          title: "Caused by",
          children: formatted?.explanation ?? [Block.Note({ text: [message] })],
        }),
      );
    }
    // A known wrapper owns its nested explanation; do not walk through it a second time.
    if (formatted !== undefined) return details;
  }
  if (current instanceof Error && current.cause !== undefined)
    details.push(Block.Note({ text: ["Further cause details omitted."] }));
  return details;
};

/** One failure classification shared by every executable front end. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (Schema.is(SetupStopped)(error))
    return {
      code: error.code,
      cause: Cause.fail(error),
      ...setupStoppedFailure(error, classifyFailure),
    };
  const formatted = dataFailure(error);
  if (formatted !== undefined)
    return {
      code: isSkitFailure(error) ? error.code : "OPERATION_FAILED",
      cause: Cause.fail(error),
      ...formatted,
    };
  const failure = isSkitFailure(error) ? error : undefined;
  // Anything not named as a failure is a defect or a platform error nothing translated. It ends
  // the command with exit 1, as an unclassified failure always has.
  const code = failure?.code ?? "OPERATION_FAILED";
  return {
    code,
    cause: Cause.fail(error),
    ...describeFailure({
      summary: [errorMessage(error)],
      details: nativeCauseDetails(error),
      next: ["Check the reported failure and retry."],
    }),
  };
}

/** A result keeps the native cause and code; words are chosen only by its presenter. */
export function commandError(cause: Cause.Cause<unknown>): CommandError {
  const first = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  const error =
    first?._tag === "Fail" ? first.error : first?._tag === "Die" ? first.defect : undefined;
  return { code: isSkitFailure(error) ? error.code : "OPERATION_FAILED", cause };
}

/** The presentation boundary consumes a Cause only after the operation's scopes close. */
export function commandFailure<E>(cause: Cause.Cause<E>): ClassifiedFailure {
  const errors = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
  const first = errors[0];
  const failure = classifyFailure(first);
  // Independent failures retain their own actions; only a wrapper's primary action is lifted.
  const additional = errors.slice(1).map(classifyFailure);
  const additionalBlocks = additional.map((failure) =>
    Block.Group({
      title: "Additional failure",
      children: failure.presentation,
    }),
  );
  return {
    ...failure,
    cause,
    explanation: [...failure.explanation, ...additionalBlocks],
    presentation: [...failure.presentation, ...additionalBlocks],
    // Cause reasons do not identify finalizers; describe secondary failures without
    // mislabelling an arbitrary programming defect as cleanup.
    message:
      errors.length > 1
        ? [
            failure.message,
            ...additional.map((failure) => `Additional failure: ${failure.message}`),
          ].join("\n")
        : failure.message,
  };
}
