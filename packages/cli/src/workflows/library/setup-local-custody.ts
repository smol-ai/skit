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
  sourcePath: Schema.optionalKey(Schema.String),
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
      "source-required",
      "source-not-candidate",
      "path-not-projection-target",
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
    const selectionKey = `${selection.name}\0${selection.sourcePath ?? ""}`;
    if (selectedCandidates.has(selectionKey))
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "duplicate-selection",
      });
    selectedCandidates.add(selectionKey);
    const candidate = current.onboarding.candidates.find(
      (item) =>
        item.name === selection.name &&
        (selection.sourcePath === undefined || item.paths.includes(selection.sourcePath)),
    );
    if (!candidate)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "candidate-not-found",
      });
    if (
      candidate.action !== "manage-locally" &&
      candidate.action !== "harness-owned" &&
      candidate.action !== "repository-owned"
    )
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "candidate-not-manageable",
      });
    const sourcePath =
      candidate.action === "manage-locally" && candidate.sourceSelection === "automatic"
        ? candidate.sourcePath
        : (selection.sourcePath ?? (candidate.paths.length === 1 ? candidate.paths[0] : undefined));
    if (!sourcePath)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-required",
      });
    if (!candidate.paths.includes(sourcePath))
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-not-candidate",
      });
    if (candidate.action === "repository-owned") {
      const retained = yield* addLibrarySourceEffect({}, sourcePath);
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
    const targetsByObservedPath = candidate.paths.map((path) => {
      const instance = current.instances.find((item) => item.path === path);
      const targets = (instance?.harnesses ?? []).flatMap((harness) => {
        return instance?.scope === "global"
          ? [{ path, harness, scope: { kind: "global" as const } }]
          : [];
      });
      return { observedPath: path, targets };
    });
    if (targetsByObservedPath.some((entry) => entry.targets.length === 0))
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "path-not-projection-target",
      });
    const targets: LocalAdoptionTarget[] = targetsByObservedPath.flatMap((entry) => entry.targets);
    const adoptionPlan = yield* planLocalAdoption(options.adoption, targets, sourcePath);
    plans.push({ name: selection.name, plan: adoptionPlan });
    const changes = adoptionPlan.targets
      .filter((target) => target.status === "adoptable")
      .map((target) => ({
        path: target.path,
        harness: target.harness,
        scope: target.scope,
        before: "unmanaged" as const,
        after: "managed" as const,
        contentHash: target.observedHash,
      }));
    if (changes.length > 0 && !current.machineConfig.machineId)
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
    const retained = yield* addLibrarySourceEffect({ standalone: true }, adoptionPlan.sourcePath);
    const subjectId = retained.collection_id ?? retained.skill_ids[0];
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
