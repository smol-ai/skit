import { Effect, Schema } from "effect";
import { LibraryStore, FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";
import { approveManage, prepareManage, type ManageOptions } from "./manage-existing.js";
import { SetupCopySelection, copyConflict, isSetupInstallDestination } from "./setup-decisions.js";
import type { SetupResult } from "./setup-contract.js";

const SetupManageSelections = Schema.Array(SetupCopySelection);

export class SetupManageSelectionInvalid
  extends Data.TaggedError("SetupManageSelectionInvalid")<{
    name: string;
    reason:
      | "duplicate-selection"
      | "candidate-not-found"
      | "candidate-not-manageable"
      | "source-not-candidate"
      | "machine-identity-required"
      | "duplicate-action-required"
      | "keep-both-replaces-link"
      | "aliases-not-retirable"
      | "copies-not-preservable";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message() {
    return `Cannot manage ${this.name} locally during setup: ${this.reason}`;
  }
}

/** Apply each explicitly selected local-ownership candidate from the approved setup observation. */
export const manageSetupCopies = Effect.fn("Setup.manageCopies")(
  function* (
    options: ManageOptions,
    current: SetupResult,
    selectionInput: readonly SetupCopySelection[],
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(SetupManageSelections)(selectionInput);
    yield* (yield* LibraryStore).load;
    const selections = yield* Effect.forEach(decoded, (selection) =>
      approveManage(
        selection,
        copyConflict(current, selection),
        (reason) => new SetupManageSelectionInvalid({ name: selection.name, reason }),
      ),
    );
    const selectedCandidates = new Set<string>();
    const recoveryDirectories: string[] = [];
    const warnings: { name: string; message: string }[] = [];
    for (const selection of selections) {
      const selectionKey = `${selection.name}\0${selection.sourcePath}`;
      if (selectedCandidates.has(selectionKey))
        return yield* new SetupManageSelectionInvalid({
          name: selection.name,
          reason: "duplicate-selection",
        });
      selectedCandidates.add(selectionKey);
      const candidate = current.onboarding.candidates.find(
        (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
      );
      if (!candidate)
        return yield* new SetupManageSelectionInvalid({
          name: selection.name,
          reason: "candidate-not-found",
        });
      if (
        candidate.action !== "manage-locally" &&
        candidate.action !== "harness-owned" &&
        candidate.action !== "repository-owned" &&
        candidate.action !== "leave-alone" &&
        !(candidate.action === "blocked" && candidate.reason === "divergent-copies")
      )
        return yield* new SetupManageSelectionInvalid({
          name: selection.name,
          reason: "candidate-not-manageable",
        });
      const selectedInstance = current.instances.find(
        (instance) => instance.path === selection.sourcePath,
      );
      if (!selectedInstance)
        return yield* new SetupManageSelectionInvalid({
          name: selection.name,
          reason: "source-not-candidate",
        });
      const observedHash = selectedInstance.contentIdentity.observedHash;
      const equalCopies = current.instances
        .filter(
          (instance) =>
            instance.name === selection.name &&
            instance.path !== selection.sourcePath &&
            observedHash !== undefined &&
            instance.contentIdentity.observedHash === observedHash &&
            isSetupInstallDestination(instance),
        )
        .map((instance) => instance.path);
      const manage = yield* prepareManage(options, selection, {
        kind: "retain",
        observedHash,
        ...(equalCopies.length ? { equalCopies } : {}),
        ...(candidate.action === "repository-owned" || !isSetupInstallDestination(selectedInstance)
          ? {}
          : {
              ownership: {
                harnesses: selectedInstance.harnesses,
                machineId: current.machineConfig.machineId,
              },
            }),
      });
      const bound = yield* manage.apply();
      recoveryDirectories.push(...bound.recoveryDirectories);
      warnings.push(...bound.warnings);
    }
    return { planId: current.onboarding.planId, recoveryDirectories, warnings };
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag("ManageInvalid", (error) =>
        Effect.fail(new SetupManageSelectionInvalid({ name: error.name, reason: error.reason })),
      ),
    ),
);
