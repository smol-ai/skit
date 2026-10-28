import { Data, Effect, Schema } from "effect";
import { LibraryStore, FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { checkManageSelection, manageCopy, type ManageOptions } from "./manage-existing.js";
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
      | "candidate-not-bindable"
      | "source-not-candidate"
      | "machine-identity-required"
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
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message() {
    return `Cannot manage ${this.name} during setup: ${this.reason}`;
  }
}

/**
 * Manage the copies setup selected from the approved scan: `existing` copies match a Library entry
 * already, `new` copies bring their files into the Library. Every selection is checked before any
 * is managed.
 */
export const manageSetupCopies = Effect.fn("Setup.manageCopies")(
  function* (
    options: ManageOptions,
    current: SetupResult,
    selectionInput: readonly SetupCopySelection[],
    kind: "existing" | "new",
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(SetupManageSelections)(selectionInput);
    yield* (yield* LibraryStore).load;
    const selections = yield* Effect.forEach(decoded, (selection) =>
      checkManageSelection(
        selection,
        copyConflict(current, selection),
        (reason) => new SetupManageSelectionInvalid({ name: selection.name, reason }),
      ),
    );
    const invalid = (name: string, reason: SetupManageSelectionInvalid["reason"]) =>
      new SetupManageSelectionInvalid({ name, reason });
    const selected = new Set<string>();
    const results = [];
    const recoveryDirectories: string[] = [];
    const warnings: { name: string; message: string }[] = [];
    for (const selection of selections) {
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
      let managed;
      if (kind === "existing") {
        if (candidate.action !== "bind-existing-entry")
          return yield* invalid(name, "candidate-not-bindable");
        const currentHash = instance?.contentIdentity.currentHash;
        if (!currentHash) return yield* invalid(name, "content-identity-missing");
        if (instance.scope !== "global" || !instance.harnesses.length)
          return yield* invalid(name, "path-not-projection-target");
        managed = yield* manageCopy(options, selection, {
          kind: "existing",
          subjectId: candidate.subjectId,
          currentHash,
        });
      } else {
        if (
          candidate.action !== "manage-locally" &&
          candidate.action !== "harness-owned" &&
          candidate.action !== "repository-owned" &&
          candidate.action !== "leave-alone" &&
          !(candidate.action === "blocked" && candidate.reason === "divergent-copies")
        )
          return yield* invalid(name, "candidate-not-manageable");
        if (!instance) return yield* invalid(name, "source-not-candidate");
        const currentHash = instance.contentIdentity.currentHash;
        const equalCopies = current.instances
          .filter(
            (other) =>
              other.name === name &&
              other.path !== sourcePath &&
              currentHash !== undefined &&
              other.contentIdentity.currentHash === currentHash &&
              isSetupInstallDestination(other),
          )
          .map((other) => other.path);
        managed = yield* manageCopy(options, selection, {
          kind: "retain",
          currentHash,
          ...(equalCopies.length ? { equalCopies } : {}),
          ...(candidate.action === "repository-owned" || !isSetupInstallDestination(instance)
            ? {}
            : {
                ownership: {
                  harnesses: instance.harnesses,
                  machineId: current.machineConfig.machineId,
                },
              }),
        });
      }
      if (managed.result !== undefined) results.push(managed.result);
      recoveryDirectories.push(...managed.recoveryDirectories);
      warnings.push(...managed.warnings);
    }
    return { planId: current.onboarding.planId, results, recoveryDirectories, warnings };
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag("ManageInvalid", (error) =>
        Effect.fail(new SetupManageSelectionInvalid({ name: error.name, reason: error.reason })),
      ),
    ),
);
