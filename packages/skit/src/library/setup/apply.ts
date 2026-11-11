import { Clock, Effect, Option, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { type Hash } from "../../shared/hash.js";
import * as MachineSettings from "../machine-settings.js";
import { stepRouting } from "../routing/step.js";
import type * as Library from "../library.js";
import { Service } from "../service.js";
import type { ManageOptions } from "./manage-existing.js";
import { revalidateSetupPlan, type SetupOptions } from "./scan.js";
import type { SetupKnownSourceSelection, SetupResult } from "./contract.js";
import { type SetupCopySelection } from "./decisions.js";
import { setupExistingSelections, setupNewSelections } from "./manage.js";
import { setupImportRequests } from "./import.js";
import type { SetupRemovals } from "./removal.js";
import { SetupStopReason } from "../store/state-schema.js";

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
}

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SetupApplyStage = Schema.TaggedUnion({
  Import: { collections: Count, skills: Count },
  ManageExisting: { reconnects: Count },
  ManageNew: { skills: Count },
  Remove: { copies: Count },
});
export type SetupApplyStage = typeof SetupApplyStage.Type;
export const SetupProgress = Schema.TaggedUnion({
  RevalidatePlan: {},
  ApplyPlan: { stages: Schema.Array(SetupApplyStage) },
  SaveDiscoveryRoots: {},
});
export type SetupProgress = typeof SetupProgress.Type;

export interface SetupApplyOptions {
  readonly manage: ManageOptions;
  /** Runs each operation with its stage facts; the caller owns progress presentation. */
  readonly withStage: <A, E, R>(
    progress: SetupProgress,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * The Library stopped this setup part way: what ran stays, nothing is rolled back, and the user
 * can undo it by its operation ID.
 */
export class SetupStopped
  extends Schema.TaggedError<SetupStopped, { readonly brand: unique symbol }>()("SetupStopped", {
    operationId: Schema.String,
    reason: SetupStopReason,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
}

/**
 * Apply an approved setup plan from one scan that reproduces the approved plan ID, which covers
 * the observed copies and the Library revision. No step observes again, so consent never moves to
 * a plan the user did not review.
 *
 * The approval becomes the Library's setup steps, each recording the folders it expects: imports,
 * then copies bound and managed, removals last. The Library saves them before any
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
  const revalidated = yield* options.withStage(
    { _tag: "RevalidatePlan" },
    revalidateSetupPlan(approval.setup, approval.planId),
  );
  // Imports and managed copies are recorded under this machine's identity, created once.
  const home = approval.setup.libraryHome;
  const needsIdentity = approval.imports.length > 0 || approval.ownership.length > 0;
  const machineId = needsIdentity
    ? Option.some(yield* MachineSettings.ensureIdentity(home))
    : Option.none();
  const at = new Date(yield* Clock.currentTimeMillis).toISOString();
  const steps: Library.SetupStep[] = [];
  const stages: SetupApplyStage[] = [];
  if (approval.imports.length && Option.isSome(machineId)) {
    const requests = yield* setupImportRequests(
      revalidated.scan,
      approval.imports,
      machineId.value,
      at,
    );
    steps.push(...requests.map((request) => ({ _tag: "Import" as const, request })));
    stages.push({ _tag: "Import", collections: requests.length, skills: approval.imports.length });
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
    stages.push({ _tag: "ManageExisting", reconnects });
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
    stages.push({ _tag: "ManageNew", skills: approval.ownership.length });
  }
  if (approval.removals.folders.length) {
    steps.push({ _tag: "Remove", folders: approval.removals.folders });
    const count = approval.removals.entries.length;
    stages.push({ _tag: "Remove", copies: count });
  }
  const outcome = yield* options.withStage(
    { _tag: "ApplyPlan", stages },
    library.setup(steps, { base }),
  );
  if (outcome._tag === "Stopped")
    return yield* new SetupStopped({
      operationId: outcome.operationId,
      reason: outcome.reason,
    });

  let current: SetupResult = revalidated.scan;
  if (approval.persistRoots || (needsIdentity && !revalidated.scan.machineConfig.machineId)) {
    const saved = yield* options.withStage(
      { _tag: "SaveDiscoveryRoots" },
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
    operationId: outcome.operationId,
  };
});
