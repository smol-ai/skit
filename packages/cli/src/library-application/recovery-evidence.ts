import { Effect, Schema } from "effect";
import {
  FailureTypeId,
  recoveryFingerprint as libraryFingerprint,
  type SkitFailure,
} from "@smolai/skit-core";

export class RecoveryInvalid
  extends Schema.TaggedError<RecoveryInvalid>()("RecoveryInvalid", { detail: Schema.String })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Recovery cannot proceed: ${this.detail}`;
  }
  readonly remediation =
    "Inspect the saved files and their move record; keep both before resolving the conflict.";
}

/** Includes control files, empty directories and link text; never follows symlinks. */
export const recoveryFingerprint = (root: string, ownership: "include" | "exclude" = "include") =>
  libraryFingerprint(root, ownership).pipe(
    Effect.catchTag("TreeError", (error) =>
      Effect.fail(new RecoveryInvalid({ detail: error.message })),
    ),
  );
