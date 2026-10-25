import {
  approveLocalAdoption,
  prepareLocalAdoption,
  type LocalAdoptionOptions,
} from "./local-adoption.js";
import { Data, Effect } from "effect";
import type { SetupResult } from "./setup-contract.js";

import { copyConflict, type SetupCopySelection } from "./setup-decisions.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class SetupExistingBindingInvalid
  extends Data.TaggedError("SetupExistingBindingInvalid")<{
    name: string;
    reason:
      | "duplicate-selection"
      | "candidate-not-found"
      | "candidate-not-bindable"
      | "path-not-projection-target"
      | "content-identity-missing"
      | "duplicate-action-required"
      | "keep-both-replaces-link"
      | "aliases-not-retirable";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message() {
    return `Cannot bind ${this.name} to an existing Library entry during setup: ${this.reason}`;
  }
}

/** Take custody using an exact existing Library Artifact, from the approved setup observation. */
export const applySetupExistingBindings = Effect.fn("Setup.applyExistingBindings")(function* (
  options: LocalAdoptionOptions,
  current: SetupResult,
  selectedCopies: readonly SetupCopySelection[],
) {
  const selections = yield* Effect.forEach(selectedCopies, (selection) =>
    approveLocalAdoption(
      selection,
      copyConflict(current, selection),
      (reason) => new SetupExistingBindingInvalid({ name: selection.name, reason }),
    ),
  );
  const selected = new Set<string>();
  const results = [];
  const recoveryDirectories: string[] = [];
  const warnings: { name: string; message: string }[] = [];
  for (const selection of selections) {
    const { name, sourcePath: selectedPath } = selection;
    if (selected.has(name))
      return yield* new SetupExistingBindingInvalid({ name, reason: "duplicate-selection" });
    selected.add(name);
    const candidate = current.onboarding.candidates.find(
      (item) => item.name === name && item.paths.includes(selectedPath),
    );
    if (!candidate)
      return yield* new SetupExistingBindingInvalid({ name, reason: "candidate-not-found" });
    if (candidate.action !== "bind-existing-entry")
      return yield* new SetupExistingBindingInvalid({
        name,
        reason: "candidate-not-bindable",
      });

    const instance = current.instances.find((item) => item.path === selectedPath);
    const observedHash = instance?.contentIdentity.observedHash;
    if (!observedHash)
      return yield* new SetupExistingBindingInvalid({ name, reason: "content-identity-missing" });
    if (instance.scope !== "global" || !instance.harnesses.length)
      return yield* new SetupExistingBindingInvalid({ name, reason: "path-not-projection-target" });

    const adoption = yield* prepareLocalAdoption(options, selection, {
      kind: "existing",
      subjectId: candidate.subjectId,
      observedHash,
    });
    const bound = yield* adoption.apply();
    if (bound.result !== undefined) results.push(bound.result);
    recoveryDirectories.push(...bound.recoveryDirectories);
    warnings.push(...bound.warnings);
  }
  return { planId: current.onboarding.planId, results, recoveryDirectories, warnings };
});
