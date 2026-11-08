import { Clock, Effect, Option, Predicate, Schema } from "effect";
import { canonicalJson } from "../../shared/json.js";
import { currentSkillVersion } from "../library-contracts.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { type Hash } from "../../shared/hash.js";
import * as MachineSettings from "../machine-settings.js";
import { stepRouting } from "../routing/step.js";
import type * as Library from "../library.js";
import { Service } from "../service.js";
import type { ManageOptions } from "./manage-existing.js";
import { revalidateSetupPlan, type SetupOptions } from "./scan.js";
import type {
  SetupKnownSourceSelection,
  SetupResult,
  InstalledSkillChange,
  SetupVersionChoice,
  InstalledSkillChangeResult,
} from "./contract.js";
import { type SetupCopySelection } from "./decisions.js";
import { setupExistingSelections, setupNewSelections } from "./manage.js";
import { setupImportRequests } from "./import.js";
import type { SetupRemovals } from "./removal.js";
import {
  changeResults,
  hasChangesToApply,
  ChangeChoiceRequired,
  changesNeedingChoice,
  setupVersionAlternatives,
} from "./installed-skills.js";
import { StalePlan } from "../library-plan.js";

/** What the user reviewed and approved: the plan ID they saw and the selections they made. */
export interface SetupApproval {
  readonly setup: SetupOptions;
  readonly planId: Hash;
  /** Save the discovery roots and repository decisions this setup observes. */
  readonly persistRoots: boolean;
  readonly imports: readonly SetupKnownSourceSelection[];
  readonly bindings: readonly SetupCopySelection[];
  readonly ownership: readonly SetupCopySelection[];
  readonly removals: SetupRemovals;
  readonly versionChoices?: readonly SetupVersionChoice[];
  readonly changes?: readonly InstalledSkillChange[];
}

export interface SetupApplyOptions {
  readonly manage: ManageOptions;
  /** Runs each stage under its progress message. */
  readonly withStatus: <A, E, R>(
    message: string,
    stage: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * The Library stopped this setup part way: what ran stays, nothing is rolled back, and the user
 * can undo it by its operation ID.
 */
export class SetupStopped
  extends Schema.TaggedError<SetupStopped, { readonly brand: unique symbol }>()("SetupStopped", {
    operationId: Schema.String,
    step: Schema.Int,
    detail: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Setup ${this.operationId} stopped at step ${this.step + 1}: ${this.detail}`;
  }
  get remediation() {
    return `Nothing was rolled back. Preview undoing it with skit library undo ${this.operationId}, or run skit setup again to review the current plan.`;
  }
}

/** What stopped a setup, in a sentence. */
const stopDetail = (reason: Library.SetupStopReason) => {
  switch (reason._tag) {
    case "EvidenceDiffers":
      return `${reason.path} changed after it was reviewed`;
    case "LibraryChanged":
      return "the Library changed while setup ran";
    case "StepFailed":
      return Predicate.hasProperty(reason.error, "message") &&
        Predicate.isString(reason.error.message)
        ? reason.error.message
        : reason.error._tag;
  }
};

/** A reviewed change as a setup step records it. */
const recordedChange = (change: InstalledSkillChange): Library.ReviewedInstalledSkillChange => ({
  installedSkillId: Option.fromUndefinedOr(change.installedSkillId),
  skillId: change.skillId,
  name: change.name,
  path: change.path,
  destination: change.destination,
  baselineHash: Option.fromUndefinedOr(change.baselineHash),
  currentHash: Option.fromUndefinedOr(change.currentHash),
  desiredHash: Option.fromUndefinedOr(change.desiredHash),
  desiredVersionId: Option.fromUndefinedOr(change.desiredVersionId),
  evidence: change.evidence,
  status: change.status,
  metadataChanged: change.metadataChanged,
});

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * Apply an approved setup plan from one scan that reproduces the approved plan ID, which covers
 * the observed copies and the Library revision. No step observes again, so consent never moves to
 * a plan the user did not review.
 *
 * The approval becomes the Library's setup steps, each recording the folders it expects: imports,
 * then copies bound and managed, then updates, removals last. The Library saves them before any
 * runs, refuses them if it changed since the scan, and checks each folder as recorded before
 * touching it. Then this machine's discovery folders are saved under the same operation ID.
 */
export const applySetupPlan = Effect.fn("Setup.applyPlan")(function* (
  options: SetupApplyOptions,
  approval: SetupApproval,
) {
  const library = yield* Service;
  // Read before the scan: a change after it fails the plan ID, one after this read the setup.
  const base = yield* library.read;
  const revalidated = yield* options.withStatus(
    "Revalidating the approved setup plan",
    revalidateSetupPlan(approval.setup, approval.planId),
  );
  const installedSkillChanges = approval.changes ?? revalidated.scan.changes ?? [];
  const reviewedPaths = new Set<string>();
  for (const fact of installedSkillChanges) {
    if (
      reviewedPaths.has(fact.path) ||
      canonicalJson(fact) !==
        canonicalJson(revalidated.scan.changes?.find((item) => item.path === fact.path) ?? null)
    )
      return yield* new StalePlan({ message: "The Library changed since this was previewed" });
    reviewedPaths.add(fact.path);
  }
  const reviewedSkills = new Set(installedSkillChanges.map((fact) => fact.skillId));
  if (
    (revalidated.scan.changes ?? []).some(
      (fact) => reviewedSkills.has(fact.skillId) && !reviewedPaths.has(fact.path),
    )
  )
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  const versionChoices = approval.versionChoices ?? [];
  const alternatives = setupVersionAlternatives(installedSkillChanges);
  if (
    new Set(versionChoices.map((choice) => choice.skillId)).size !== versionChoices.length ||
    versionChoices.some(
      (choice) =>
        !alternatives.some((alternative) => canonicalJson(choice) === canonicalJson(alternative)),
    )
  )
    return yield* new StalePlan({ message: "The Library changed since this was previewed" });
  const unresolved = changesNeedingChoice(installedSkillChanges, versionChoices);
  if (unresolved.length) return yield* new ChangeChoiceRequired({ facts: unresolved });
  // Writability checks create directories. Library.setup records their paths and ancestry before
  // preparing them, and stops before any Import/Manage/Update step if preparation fails.
  const scanChanges = revalidated.scan.changes ?? [];
  const updating = hasChangesToApply(installedSkillChanges, versionChoices);

  // Imports and managed copies are recorded under this machine's identity, created once.
  const home = approval.setup.libraryHome;
  const needsIdentity = approval.imports.length > 0 || approval.ownership.length > 0;
  const machineId = needsIdentity
    ? Option.some(yield* MachineSettings.ensureIdentity(home))
    : Option.none();
  const at = new Date(yield* Clock.currentTimeMillis).toISOString();
  const steps: Library.SetupStep[] = [];
  const stages: string[] = [];
  if (approval.imports.length && Option.isSome(machineId)) {
    const requests = yield* setupImportRequests(
      revalidated.scan,
      approval.imports,
      machineId.value,
      at,
    );
    steps.push(...requests.map((request) => ({ _tag: "Import" as const, request })));
    stages.push(
      `importing ${requests.length} installed ${plural(requests.length, "Collection", "Collections")} (${approval.imports.length} ${plural(approval.imports.length, "Skill", "Skills")})`,
    );
  }
  const manageRouting = yield* stepRouting(options.manage.installOptions, revalidated.library);
  if (approval.bindings.length) {
    steps.push({
      _tag: "Manage",
      mode: "existing",
      selections: yield* setupExistingSelections(revalidated.scan, approval.bindings),
      routing: manageRouting,
    });
    const reconnects = approval.bindings.filter(
      (selection) => selection.duplicateAction !== "retain-only",
    ).length;
    stages.push(
      reconnects
        ? `reconnecting ${reconnects} existing Library ${plural(reconnects, "match", "matches")}`
        : "keeping existing Library matches without enabling",
    );
  }
  if (approval.ownership.length && Option.isSome(machineId)) {
    steps.push({
      _tag: "Manage",
      mode: "new",
      selections: yield* setupNewSelections(
        revalidated.scan,
        approval.ownership,
        machineId.value,
        at,
      ),
      routing: manageRouting,
    });
    stages.push(
      `managing ${approval.ownership.length} existing local ${plural(approval.ownership.length, "Skill", "Skills")}`,
    );
  }
  if (updating) {
    steps.push({
      _tag: "Update",
      changes: installedSkillChanges.map(recordedChange),
      versionChoices: versionChoices.map((choice) => ({
        skillId: choice.skillId,
        version: choice.version,
        path: Option.fromUndefinedOr(choice.path),
      })),
      importedAt: at,
      routing: yield* stepRouting(approval.setup.inventory, revalidated.library),
    });
    stages.push(
      versionChoices.length
        ? "applying the selected active versions"
        : "updating reviewed existing copies",
    );
  }
  if (approval.removals.folders.length) {
    steps.push({ _tag: "Remove", folders: approval.removals.folders });
    const count = approval.removals.entries.length;
    stages.push(`removing ${count} installed ${plural(count, "copy", "copies")}`);
  }
  const outcome = yield* options.withStatus(
    stages.length ? `Applying setup: ${stages.join(", ")}` : "Recording this machine's setup",
    library.setup(steps, { base }),
  );
  if (outcome._tag === "Stopped")
    return yield* new SetupStopped({
      operationId: outcome.operationId,
      step: outcome.reason.step,
      detail: stopDetail(outcome.reason),
    });

  let current: SetupResult = revalidated.scan;
  if (approval.persistRoots || (needsIdentity && !revalidated.scan.machineConfig.machineId)) {
    const saved = yield* options.withStatus(
      "Saving this machine's discovery roots",
      MachineSettings.updateDiscovery(
        approval.setup.libraryHome,
        {
          // An empty scan selection never clears saved discovery roots.
          ...(approval.setup.repositoryRoots?.length
            ? { discoveryRoots: approval.setup.repositoryRoots }
            : {}),
          repositories: approval.setup.repositoryDecisions,
          ...(approval.setup.machineDisplayName === undefined
            ? {}
            : { displayName: approval.setup.machineDisplayName }),
        },
        undefined,
        outcome.operationId,
      ),
    );
    current = {
      ...current,
      machineConfig: {
        ...current.machineConfig,
        ...(saved.machineId === undefined ? {} : { machineId: saved.machineId }),
        ...(saved.displayName === undefined ? {} : { displayName: saved.displayName }),
        persisted: approval.persistRoots,
      },
    };
  }
  const updated = outcome.steps.flatMap((step) => (step._tag === "Update" ? step.changes : []));
  // A source import can change the Version a reviewed copy should hold; that copy then needs a
  // fresh review. (An update this setup ran would have stopped on it instead.)
  const after = updating || !approval.imports.length ? undefined : yield* library.read;
  const deferred =
    after?._tag === "Present" &&
    scanChanges.some((fact) => {
      const skill = after.state.skills.find((item) => item.skill_id === fact.skillId);
      return (
        skill !== undefined &&
        currentSkillVersion(after.state, skill)?.skill_version_id !== fact.desiredVersionId
      );
    });
  const changes: InstalledSkillChangeResult[] = updating
    ? [...updated]
    : deferred
      ? installedSkillChanges.map((fact) => ({
          ...(fact.installedSkillId === undefined
            ? {}
            : { installedSkillId: fact.installedSkillId }),
          name: fact.name,
          path: fact.path,
          status: fact.status === "native-delete" ? "native-delete" : "pending",
          reason:
            "The source import changed the desired Version. Observe setup and review these copies again; this apply leaves them untouched.",
        }))
      : changeResults(installedSkillChanges, true);
  return {
    scan: current,
    warnings: outcome.warnings,
    /** Where duplicates moved aside while managing copies were saved. */
    recoveryDirectories: outcome.steps.flatMap((step) =>
      step._tag === "Manage" ? step.recoveryDirectories : [],
    ),
    /** Where the removed copies were saved, when the plan removed any. */
    removalDirectory: outcome.steps.flatMap((step) =>
      step._tag === "Remove" ? [step.recoveryDirectory] : [],
    )[0],
    changes,
    operationId: outcome.operationId,
  };
});
