import {
  planSetupAliasRetirement,
  captureSetupAliasApproval,
  retireSetupAliases,
} from "./setup-local-custody.js";
import { observeHarnessShadows } from "../../projection/harness-shadows.js";
import { Effect, Schema } from "effect";
import { LibraryStore, type Digest } from "@smolai/skit-core";
import type { ProjectionOptions } from "./projection-options.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";
import { applyLibraryBindings } from "./set-enabled.js";
import { PlanIsStale } from "../../library/failures.js";

import {
  copyConflict,
  type SetupApprovedAlias,
  type SetupDuplicateAction,
} from "./setup-decisions.js";

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

export interface SetupExistingBindingSelection {
  readonly name: string;
  readonly path: string;
  readonly duplicateAction?: SetupDuplicateAction;
  readonly approvedAliases?: readonly SetupApprovedAlias[];
}

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
  const store = yield* LibraryStore;
  const selections = yield* Effect.forEach(selectedCopies, (selection) =>
    Effect.gen(function* () {
      const conflict = copyConflict(current, { name: selection.name, sourcePath: selection.path });
      if (conflict.kind !== "none" && !selection.duplicateAction)
        return yield* new SetupExistingBindingInvalid({
          name: selection.name,
          reason: "duplicate-action-required",
        });
      if (selection.duplicateAction !== "retire-aliases") return selection;
      if (conflict.kind !== "retirable")
        return yield* selection.approvedAliases
          ? new PlanIsStale()
          : new SetupExistingBindingInvalid({
              name: selection.name,
              reason: "aliases-not-retirable",
            });
      return {
        ...selection,
        approvedAliases: yield* captureSetupAliasApproval(
          selection.path,
          conflict.shadows,
          selection.approvedAliases,
        ),
      };
    }),
  );
  const selected = new Set<string>();
  const results = [];
  const recoveryDirectories: string[] = [];
  const warnings: { name: string; message: string }[] = [];
  for (const { name, path: selectedPath, duplicateAction, approvedAliases } of selections) {
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
    const state = yield* store.load;
    results.push(
      yield* applyLibraryBindings(state, {
        query: candidate.subjectId,
        all: false,
        allowDuplicate: duplicateAction === "keep-both",
        ...(retirement
          ? {
              allowedShadowAliases: retirement.entries.map((entry) => ({
                ...entry,
                canonicalPath: selectedPath,
              })),
            }
          : {}),
        selectedSkills: [name],
        invocation: {
          subjects: [candidate.subjectId],
          scope: { kind: "global" },
          enabled: true,
          dryRun: false,
        },
        roots: options.bindings,
        variantsPath: options.bindings.variantsPath,
        adoption: { path: selectedPath, observedHash },
      }),
    );
    if (retirement) {
      const outcome = yield* retireSetupAliases(
        options.setup.inventory,
        candidate.subjectId,
        name,
        retirement,
      );
      if (outcome.kind === "retired") recoveryDirectories.push(retirement.recoveryDirectory);
      else warnings.push({ name, message: outcome.message });
    }
  }
  return { planId: current.onboarding.planId, results, recoveryDirectories, warnings };
});
