import { Effect, Schema } from "effect";
import { LibraryStore, type Digest, type HarnessName } from "@smolai/skit-core";
import { resolve } from "node:path";
import type { ProjectionOptions } from "./projection-options.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";
import { applyLibraryBindings } from "./portable-set-enabled.js";

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
  selectedNames: readonly string[],
) {
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  const portable = yield* (yield* LibraryStore).load;
  const selected = new Set<string>();
  const results = [];
  for (const name of selectedNames) {
    if (selected.has(name))
      return yield* new SetupExistingBindingInvalid({ name, reason: "duplicate-selection" });
    selected.add(name);
    const candidate = current.onboarding.candidates.find((item) => item.name === name);
    if (!candidate)
      return yield* new SetupExistingBindingInvalid({ name, reason: "candidate-not-found" });
    if (candidate.action !== "bind-existing-entry")
      return yield* new SetupExistingBindingInvalid({
        name,
        reason: "candidate-not-bindable",
      });

    const targets: Array<{ path: string; harness: HarnessName }> = [];
    for (const path of candidate.paths) {
      const instance = current.instances.find((item) => item.path === path);
      const observedHash = instance?.contentIdentity.observedHash;
      if (!observedHash)
        return yield* new SetupExistingBindingInvalid({
          name,
          reason: "content-identity-missing",
        });
      const matching = (instance?.harnesses ?? []).flatMap((harness) => {
        return instance?.scope === "global" ? [{ path: resolve(path), harness }] : [];
      });
      if (!matching.length)
        return yield* new SetupExistingBindingInvalid({
          name,
          reason: "path-not-projection-target",
        });
      targets.push(...matching);
    }

    results.push(
      yield* applyLibraryBindings(portable, {
        query: candidate.subjectId,
        all: false,
        selectedSkills: [name],
        invocation: {
          subjects: [candidate.subjectId],
          harnesses: [...new Set(targets.map((target) => target.harness))],
          scope: { kind: "global" },
          enabled: true,
          dryRun: false,
        },
        roots: options.bindings,
        variantsPath: options.bindings.variantsPath,
      }),
    );
  }
  return { planId: current.onboarding.planId, results };
});
