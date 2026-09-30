import { Effect, Schema } from "effect";
import { LibraryStore, type Digest } from "@smolai/skit-core";
import {
  localAdoptionPlanIdentity,
  planLocalAdoption,
  type LocalAdoptionOptions,
  type LocalAdoptionPlan,
  type LocalAdoptionTarget,
} from "./local-adoption.js";
import { PlanIsStale } from "../../library/failures.js";
import { addLibrarySourceEffect } from "./add.js";
import { applyLibraryBindings } from "./set-enabled.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";

export const SetupLocalCustodySelection = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
});
export interface SetupLocalCustodySelection extends Schema.Schema.Type<
  typeof SetupLocalCustodySelection
> {}

const SetupLocalCustodySelections = Schema.Array(SetupLocalCustodySelection);

export class SetupLocalCustodySelectionInvalid extends Schema.TaggedError<SetupLocalCustodySelectionInvalid>()(
  "SetupLocalCustodySelectionInvalid",
  {
    name: Schema.String,
    reason: Schema.Literals([
      "duplicate-selection",
      "candidate-not-found",
      "candidate-not-manageable",
      "source-not-candidate",
      "machine-identity-required",
    ]),
  },
) {
  get message() {
    return `Cannot manage ${this.name} locally during setup: ${this.reason}`;
  }
}

export interface SetupLocalCustodyOptions {
  readonly setup: SetupOptions;
  readonly adoption: LocalAdoptionOptions;
}

/** Revalidate setup consent, then apply each explicitly selected local-custody candidate. */
export const applySetupLocalCustody = Effect.fn("Setup.applyLocalCustody")(function* (
  options: SetupLocalCustodyOptions,
  approvedPlanId: Digest,
  selectionInput: readonly SetupLocalCustodySelection[],
) {
  const selections = yield* Schema.decodeUnknownEffect(SetupLocalCustodySelections)(selectionInput);
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  yield* (yield* LibraryStore).load;
  const selectedCandidates = new Set<string>();
  const adopted: Array<{ readonly subject_id: string; readonly retained_version_id: string }> = [];
  const plans: Array<{ name: string; plan: LocalAdoptionPlan }> = [];
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
    const sourcePath = selection.sourcePath;
    const selectedInstance = current.instances.find((instance) => instance.path === sourcePath);
    if (
      candidate.action === "repository-owned" ||
      selectedInstance?.git.repository ||
      selectedInstance?.scope !== "global" ||
      selectedInstance.harnesses.length === 0
    ) {
      const retained = yield* addLibrarySourceEffect(sourcePath);
      if (retained.collection_id === undefined)
        return yield* new SetupLocalCustodySelectionInvalid({
          name: selection.name,
          reason: "source-not-candidate",
        });
      adopted.push({
        subject_id: retained.collection_id,
        retained_version_id: retained.retained_version_id,
      });
      continue;
    }
    // An explicit row selects only that physical copy. Differing siblings remain untouched.
    const targets: LocalAdoptionTarget[] = selectedInstance.harnesses.map((harness) => ({
      path: sourcePath,
      harness,
      scope: { kind: "global" },
    }));
    const adoptionPlan = yield* planLocalAdoption(options.adoption, targets, sourcePath);
    plans.push({ name: selection.name, plan: adoptionPlan });
    if (
      adoptionPlan.targets.some((target) => target.status === "adoptable") &&
      !current.machineConfig.machineId
    )
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "machine-identity-required",
      });
    if (!adoptionPlan.applicable || !adoptionPlan.sourcePath || !adoptionPlan.skill)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-not-candidate",
      });
    const refreshed = yield* planLocalAdoption(
      options.adoption,
      adoptionPlan.targets,
      adoptionPlan.sourcePath,
    );
    if (localAdoptionPlanIdentity(refreshed) !== localAdoptionPlanIdentity(adoptionPlan))
      return yield* new PlanIsStale();
    const retained = yield* addLibrarySourceEffect(adoptionPlan.sourcePath);
    const subjectId = retained.collection_id;
    if (subjectId === undefined)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-not-candidate",
      });
    const state = yield* (yield* LibraryStore).load;
    yield* applyLibraryBindings(state, {
      query: subjectId,
      all: false,
      selectedSkills: [selection.name],
      invocation: {
        subjects: [subjectId],
        harnesses: [...new Set(targets.map((target) => target.harness))],
        scope: { kind: "global" },
        enabled: true,
        dryRun: false,
      },
      roots: options.adoption.bindings,
      variantsPath: options.adoption.bindings.variantsPath,
      adoptionObservedHash: adoptionPlan.skill.validationDigest,
    });
    adopted.push({
      subject_id: subjectId,
      retained_version_id: retained.retained_version_id,
    });
  }
  return { planId: current.onboarding.planId, plans, adopted };
});
