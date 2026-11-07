import { Data, Effect, Option, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { readPathEvidence } from "../folder-evidence.js";
import { type Hash } from "../../shared/hash.js";
import type * as Library from "../library.js";
import { type MachineId } from "../entity-ids.js";
import { localImportRequest } from "./local-import.js";
import { StalePlan } from "../library-plan.js";
import { checkManageSelection } from "./manage-existing.js";
import {
  SetupCopySelection,
  copyConflict,
  isSetupInstallDestination,
  type ApprovedSymlink,
  type SetupApprovedCopy,
} from "./decisions.js";
import type { SetupResult } from "./contract.js";

const SetupManageSelections = Schema.Array(SetupCopySelection);

class SetupManageSelectionInvalid
  extends Data.TaggedError("SetupManageSelectionInvalid")<{
    skillName: string;
    reason:
      | "duplicate-selection"
      | "candidate-not-found"
      | "candidate-not-manageable"
      | "candidate-not-bindable"
      | "source-not-candidate"
      | "content-identity-missing"
      | "path-not-projection-target"
      | "duplicate-action-required"
      | "keep-both-replaces-link"
      | "aliases-not-retirable"
      | "copies-not-preservable";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Set up again and review the current plan.";
  get message() {
    return `Cannot manage ${this.skillName} during setup: ${this.reason}`;
  }
}

/** The folder at `path` as it is now, which must still hold the reviewed bytes. */
const reviewedFolder = Effect.fn("Setup.reviewedFolder")(function* (
  path: string,
  currentHash: Hash | undefined,
  identity?: { readonly dev: bigint; readonly ino: bigint },
) {
  const observed = yield* readPathEvidence(path);
  if (
    currentHash === undefined ||
    Option.isNone(observed) ||
    observed.value._tag !== "Directory" ||
    observed.value.treeHash !== currentHash ||
    (identity !== undefined &&
      (observed.value.dev !== identity.dev || observed.value.ino !== identity.ino))
  )
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  return observed.value;
});

/** The approved link as it is now, which must still be the same link to the same target. */
const approvedLink = Effect.fn("Setup.approvedLink")(function* (link: ApprovedSymlink) {
  const observed = yield* readPathEvidence(link.path);
  if (
    Option.isNone(observed) ||
    observed.value._tag !== "SymbolicLink" ||
    observed.value.dev !== link.dev ||
    observed.value.ino !== link.ino ||
    observed.value.linkTarget !== link.linkTarget
  )
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  return observed.value;
});

const approvedCopy = (copy: SetupApprovedCopy) =>
  reviewedFolder(copy.path, copy.currentHash, { dev: copy.dev, ino: copy.ino });

/**
 * Check each selection against the approved scan, and record what its Manage step needs: the
 * reviewed folder, and the exact duplicates its policy approves. Every selection is checked
 * before setup runs any step.
 */
const checkedSelections = Effect.fn("Setup.checkedSelections")(function* (
  current: SetupResult,
  selectionInput: readonly SetupCopySelection[],
  kind: "existing" | "new",
) {
  const decoded = yield* Schema.decodeUnknownEffect(SetupManageSelections)(selectionInput);
  const invalid = (name: string, reason: SetupManageSelectionInvalid["reason"]) =>
    new SetupManageSelectionInvalid({ skillName: name, reason });
  const selected = new Set<string>();
  const checked = [];
  for (const input of decoded) {
    const selection = yield* checkManageSelection(input, copyConflict(current, input), (reason) =>
      invalid(input.name, reason),
    );
    const { name, sourcePath } = selection;
    // An existing Library match is enabled once per name; new copies once per path.
    const key = kind === "existing" ? name : `${name}\0${sourcePath}`;
    if (selected.has(key)) return yield* invalid(name, "duplicate-selection");
    selected.add(key);
    const candidate = current.onboarding.candidates.find(
      (item) => item.name === name && item.paths.includes(sourcePath),
    );
    if (!candidate) return yield* invalid(name, "candidate-not-found");
    const instance = current.instances.find((item) => item.path === sourcePath);
    const base = {
      name,
      duplicates: Option.fromUndefinedOr(selection.duplicateAction),
      approvedSymlinks: yield* Effect.forEach(selection.approvedSymlinks ?? [], approvedLink),
      approvedCopies: yield* Effect.forEach(selection.approvedCopies ?? [], approvedCopy),
    };
    checked.push({ selection, candidate, instance, base });
  }
  return checked;
});

/** The Manage "existing" selections: each binds a copy to the Library entry it already matches. */
export const setupExistingSelections = Effect.fn("Setup.existingSelections")(function* (
  current: SetupResult,
  selections: readonly SetupCopySelection[],
) {
  const result: Library.ManageExistingSelection[] = [];
  for (const { selection, candidate, instance, base } of yield* checkedSelections(
    current,
    selections,
    "existing",
  )) {
    const { name, sourcePath } = selection;
    if (candidate.action !== "bind-existing-entry")
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "candidate-not-bindable",
      });
    const currentHash = instance?.contentIdentity.currentHash;
    if (!currentHash)
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "content-identity-missing",
      });
    if (instance.scope !== "global" || !instance.harnesses.length)
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "path-not-projection-target",
      });
    result.push({
      ...base,
      mode: "existing",
      source: yield* reviewedFolder(sourcePath, currentHash),
      subjectId: candidate.subjectId,
      currentHash,
    });
  }
  return result;
});

/**
 * The Manage "new" selections: each imports its copy as a local Source, then takes ownership of
 * it where it is an installed copy, managing equal copies at other destinations in place.
 */
export const setupNewSelections = Effect.fn("Setup.newSelections")(function* (
  current: SetupResult,
  selections: readonly SetupCopySelection[],
  machineId: MachineId,
  importedAt: string,
) {
  const result: Library.ManageNewSelection[] = [];
  for (const { selection, candidate, instance, base } of yield* checkedSelections(
    current,
    selections,
    "new",
  )) {
    const { name, sourcePath } = selection;
    if (
      candidate.action !== "manage-locally" &&
      candidate.action !== "harness-owned" &&
      candidate.action !== "repository-owned" &&
      candidate.action !== "leave-alone" &&
      !(candidate.action === "blocked" && candidate.reason === "divergent-copies")
    )
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "candidate-not-manageable",
      });
    if (!instance)
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "source-not-candidate",
      });
    const currentHash = instance.contentIdentity.currentHash;
    const equalCopies = current.instances.filter(
      (other) =>
        other.name === name &&
        other.path !== sourcePath &&
        currentHash !== undefined &&
        other.contentIdentity.currentHash === currentHash &&
        isSetupInstallDestination(other),
    );
    const request = yield* localImportRequest(sourcePath, importedAt);
    if (Option.isNone(request))
      return yield* new SetupManageSelectionInvalid({
        skillName: name,
        reason: "source-not-candidate",
      });
    result.push({
      ...base,
      mode: "new",
      source: yield* reviewedFolder(sourcePath, currentHash),
      importFrom: { _tag: "Import", request: request.value },
      currentHash: Option.fromUndefinedOr(currentHash),
      equalCopies: yield* Effect.forEach(equalCopies, (copy) =>
        reviewedFolder(copy.path, currentHash),
      ),
      ownership:
        candidate.action === "repository-owned" || !isSetupInstallDestination(instance)
          ? Option.none()
          : Option.some({
              harnesses: instance.harnesses,
              machineId: Option.some(machineId),
            }),
    });
  }
  return result;
});

export type { SetupManageSelectionInvalid };
