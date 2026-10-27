import { Effect, Schema } from "effect";
import { LibraryStore, FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";
import {
  approveLocalAdoption,
  prepareLocalAdoption,
  type LocalAdoptionOptions,
} from "./local-adoption.js";
import { SetupCopySelection, copyConflict, isSetupProjectionTarget } from "./setup-decisions.js";
import type { SetupResult } from "./setup-contract.js";

const SetupLocalCustodySelections = Schema.Array(SetupCopySelection);

export class SetupLocalCustodySelectionInvalid
  extends Data.TaggedError("SetupLocalCustodySelectionInvalid")<{
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

/** Apply each explicitly selected local-custody candidate from the approved setup observation. */
export const applySetupLocalCustody = Effect.fn("Setup.applyLocalCustody")(
  function* (
    options: LocalAdoptionOptions,
    current: SetupResult,
    selectionInput: readonly SetupCopySelection[],
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(SetupLocalCustodySelections)(selectionInput);
    yield* (yield* LibraryStore).load;
    const selections = yield* Effect.forEach(decoded, (selection) =>
      approveLocalAdoption(
        selection,
        copyConflict(current, selection),
        (reason) => new SetupLocalCustodySelectionInvalid({ name: selection.name, reason }),
      ),
    );
    const selectedCandidates = new Set<string>();
    const recoveryDirectories: string[] = [];
    const warnings: { name: string; message: string }[] = [];
    for (const selection of selections) {
      const selectionKey = `${selection.name}\0${selection.sourcePath}`;
      if (selectedCandidates.has(selectionKey))
        return yield* new SetupLocalCustodySelectionInvalid({
          name: selection.name,
          reason: "duplicate-selection",
        });
      selectedCandidates.add(selectionKey);
      const candidate = current.onboarding.candidates.find(
        (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
      );
      if (!candidate)
        return yield* new SetupLocalCustodySelectionInvalid({
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
        return yield* new SetupLocalCustodySelectionInvalid({
          name: selection.name,
          reason: "candidate-not-manageable",
        });
      const selectedInstance = current.instances.find(
        (instance) => instance.path === selection.sourcePath,
      );
      if (!selectedInstance)
        return yield* new SetupLocalCustodySelectionInvalid({
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
            isSetupProjectionTarget(instance),
        )
        .map((instance) => instance.path);
      const adoption = yield* prepareLocalAdoption(options, selection, {
        kind: "retain",
        observedHash,
        ...(equalCopies.length ? { equalCopies } : {}),
        ...(candidate.action === "repository-owned" || !isSetupProjectionTarget(selectedInstance)
          ? {}
          : {
              custody: {
                harnesses: selectedInstance.harnesses,
                machineId: current.machineConfig.machineId,
              },
            }),
      });
      const bound = yield* adoption.apply();
      recoveryDirectories.push(...bound.recoveryDirectories);
      warnings.push(...bound.warnings);
    }
    return { planId: current.onboarding.planId, recoveryDirectories, warnings };
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag("LocalAdoptionInvalid", (error) =>
        Effect.fail(
          new SetupLocalCustodySelectionInvalid({ name: error.name, reason: error.reason }),
        ),
      ),
    ),
);
