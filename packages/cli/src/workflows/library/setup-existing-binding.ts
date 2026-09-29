import { Effect, Schema } from "effect";
import { LibraryStore, type Digest } from "@smolai/skit-core";
import type { ProjectionOptions } from "./projection-options.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";
import { applyLibraryBindings } from "./set-enabled.js";

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
    ]),
  },
) {
  get message() {
    return `Cannot bind ${this.name} to an existing Library entry during setup: ${this.reason}`;
  }
}

export interface SetupExistingBindingOptions {
  readonly setup: SetupOptions;
  readonly bindings: ProjectionOptions;
}

/** Revalidate setup consent, then take custody using an exact existing Library Artifact. */
export const applySetupExistingBindings = Effect.fn("Setup.applyExistingBindings")(function* (
  options: SetupExistingBindingOptions,
  approvedPlanId: Digest,
  selectedCopies: readonly { readonly name: string; readonly path: string }[],
) {
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  const state = yield* (yield* LibraryStore).load;
  const selected = new Set<string>();
  const results = [];
  for (const { name, path: selectedPath } of selectedCopies) {
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
    const harnesses = instance.scope === "global" ? instance.harnesses : [];
    if (!harnesses.length)
      return yield* new SetupExistingBindingInvalid({ name, reason: "path-not-projection-target" });

    results.push(
      yield* applyLibraryBindings(state, {
        query: candidate.subjectId,
        all: false,
        selectedSkills: [name],
        invocation: {
          subjects: [candidate.subjectId],
          harnesses,
          scope: { kind: "global" },
          enabled: true,
          dryRun: false,
        },
        roots: options.bindings,
        variantsPath: options.bindings.variantsPath,
        adoptionObservedHash: observedHash,
      }),
    );
  }
  return { planId: current.onboarding.planId, results };
});
