import { errorMessage } from "@smolai/skit-core/shared";
import { isSkitFailure, type FailureCode } from "@smolai/skit-core/shared";
import { Cause, Predicate } from "effect";

/**
 * The exit status each failure code ends a command with. Command metadata separately publishes
 * the statuses callers may branch on, and the exit-code tests hold the two together.
 */
export const failureExitCodes = {
  NOT_FOUND: 11,
  CONFLICT: 12,
  TARGET_COLLISION: 12,
  INVALID_ARGUMENT: 64,
  VALIDATION_FAILED: 65,
  // Its own status: the command was valid, but its user must sign in first. Not 77, which
  // `author validate` already returns for a result blocked by policy.
  AUTHENTICATION_REQUIRED: 13,
  OPERATION_FAILED: 1,
} as const satisfies Record<FailureCode, number>;

export interface ClassifiedFailure {
  code: FailureCode;
  exitCode: number;
  message: string;
  remediation: string;
}

/**
 * The command that does what an owner's remediation describes. Owners speak in domain terms;
 * this executable names its own commands.
 */
const commandRemediation: Readonly<Record<string, string>> = {
  NoRemoteHome: "Run `skit author sync --to <namespace/skit>` first.",
  "Library.SnapshotArchiveInvalid":
    "Run `skit sync` again; if it persists, the stored snapshot is damaged.",
  "Library.SubjectNotFound": "Run `skit list` to find a retained Skill or Collection.",
  ContentAddressCollision: "Run `skit doctor` to inspect the Library before retrying.",
  UnknownInstalledSkill: "Run `skit list` to find an installed Skill.",
  InvalidLibraryState:
    "Back up the state file before recovery. To reset an alpha Library, move it aside and run `skit setup`; keep installed Skill files.",
  "MachineSettings.SetupNotRecorded": "Review the discovery folders with `skit setup`.",
  SetupImportInvalid: "Run `skit setup` again and review the current plan.",
  SetupManageSelectionInvalid: "Run `skit setup` again and review the current plan.",
  "Library.RestoreInvalid": "Run `skit doctor` to inspect the Library, then run `skit sync` again.",
  "Library.SyncLocalChanged": "Run `skit sync` again.",
  "Library.EditImportMissing": "Run `skit doctor` to inspect changed installed skills.",
  "Library.InstalledSkillInvalid": "Run `skit doctor` to inspect the Library, then retry.",
  InvalidUsageOptions: "Run `skit usage --help` to review its options.",
  "Library.CollectionRemovalMissing": "Run `skit list` to see the retained Collections.",
  OwnershipMarkerDisagrees: "Run `skit doctor` to inspect the installed skill before retrying.",
  InstalledSkillFileMissing: "Run `skit doctor` to inspect the installed skill, then retry.",
  InstalledSkillFailure: "Run `skit doctor` to inspect the installed skill, then retry.",
};

const tagOf = (error: object): string | undefined =>
  Predicate.hasProperty(error, "_tag") && typeof error._tag === "string" ? error._tag : undefined;

/** One failure classification shared by every executable front end. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (isSkitFailure(error)) {
    const tag = tagOf(error);
    return {
      code: error.code,
      exitCode: failureExitCodes[error.code],
      message: error.message,
      remediation: (tag === undefined ? undefined : commandRemediation[tag]) ?? error.remediation,
    };
  }
  // Anything not named as a failure is a defect or a platform error nothing translated. It ends
  // the command with exit 1, as an unclassified failure always has.
  return {
    code: "OPERATION_FAILED",
    exitCode: failureExitCodes.OPERATION_FAILED,
    message: errorMessage(error),
    remediation: "Check the reported failure and retry.",
  };
}

/** The presentation boundary consumes a Cause only after the operation's scopes close. */
export function commandFailure<E>(cause: Cause.Cause<E>): ClassifiedFailure {
  const errors = cause.reasons.flatMap((reason) =>
    Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : [],
  );
  const first = errors[0];
  const failure = classifyFailure(first);
  return {
    ...failure,
    // Cause reasons do not identify finalizers; describe secondary failures without
    // mislabelling an arbitrary programming defect as cleanup.
    message:
      errors.length > 1
        ? [
            failure.message,
            ...errors.slice(1).map((error) => `Additional failure: ${errorMessage(error)}`),
          ].join("\n")
        : failure.message,
  };
}
