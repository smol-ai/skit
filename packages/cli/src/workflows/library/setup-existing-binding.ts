import {
  planSetupAliasRetirement,
  approveSetupCopy,
  bindSetupCopy,
} from "./setup-local-custody.js";
import { observeHarnessShadows } from "../../projection/harness-shadows.js";
import { Effect, Schema } from "effect";
import { type Digest } from "@smolai/skit-core";
import type { ProjectionOptions } from "./projection-options.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";

import type { SetupCopySelection } from "./setup-decisions.js";

export class SetupExistingBindingInvalid extends Schema.TaggedError<SetupExistingBindingInvalid>()(
  "SetupExistingBindingInvalid",
  {
    name: Schema.String,
    reason: Schema.Literals([
      "duplicate-selection",
      "candidate-not-found",
      "candidate-not-bindable",
      "path-not-projection-target",
      "content-identity-missing",
      "duplicate-action-required",
      "aliases-not-retirable",
    ]),
  },
) {
  get message() {
    return `Cannot bind ${this.name} to an existing Library entry during setup: ${this.reason}`;
  }
}

export interface SetupExistingBindingSelection extends SetupCopySelection {}

export interface SetupExistingBindingOptions {
  readonly setup: SetupOptions;
  readonly bindings: ProjectionOptions;
}

/** Revalidate setup consent, then take custody using an exact existing Library Artifact. */
export const applySetupExistingBindings = Effect.fn("Setup.applyExistingBindings")(function* (
  options: SetupExistingBindingOptions,
  approvedPlanId: Digest,
  selectedCopies: readonly SetupExistingBindingSelection[],
) {
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  const selections = yield* Effect.forEach(selectedCopies, (selection) =>
    approveSetupCopy(
      current,
      selection,
      (reason) => new SetupExistingBindingInvalid({ name: selection.name, reason }),
    ),
  );
  const selected = new Set<string>();
  const results = [];
  const recoveryDirectories: string[] = [];
  const warnings: { name: string; message: string }[] = [];
  for (const { name, sourcePath: selectedPath, duplicateAction, approvedAliases } of selections) {
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

    if (duplicateAction === "retain-only") continue;
    const shadows =
      duplicateAction === "retire-aliases"
        ? yield* observeHarnessShadows(options.setup.inventory, { kind: "global" }, [name])
        : [];
    const retirement =
      duplicateAction === "retire-aliases"
        ? yield* planSetupAliasRetirement(
            options.setup.libraryHome,
            name,
            selectedPath,
            shadows,
            approvedAliases,
          )
        : undefined;
    const bound = yield* bindSetupCopy(
      options,
      { name, sourcePath: selectedPath, duplicateAction, approvedAliases },
      candidate.subjectId,
      { path: selectedPath, observedHash },
      retirement,
    );
    results.push(bound.result);
    recoveryDirectories.push(...bound.recoveryDirectories);
    warnings.push(...bound.warnings);
  }
  return { planId: current.onboarding.planId, results, recoveryDirectories, warnings };
});
