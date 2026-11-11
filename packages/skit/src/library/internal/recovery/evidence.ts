import { RecoveryInvalid } from "../../store/operation-failures.js";
import { Effect } from "effect";
import { recoveryFingerprint as libraryFingerprint } from "../../folder-evidence.js";

/** Includes control files, empty directories and link text; never follows symlinks. */
export const recoveryFingerprint = (root: string, ownership: "include" | "exclude" = "include") =>
  libraryFingerprint(root, ownership).pipe(
    Effect.catchTag("TreeError", (error) =>
      Effect.fail(new RecoveryInvalid({ reason: { _tag: "InvalidTree", reason: error.reason } })),
    ),
  );
