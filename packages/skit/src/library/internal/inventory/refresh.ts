import { Revision, type Snapshot } from "../../snapshot.js";
import { Clock, Effect, Schema } from "effect";
import { Hash } from "../../../shared/hash.js";
import { HarnessName } from "../../../harnesses/contracts.js";
import { InvalidLibraryState } from "../../failures.js";
import { OwnershipMarkerInspection } from "../../../installed-skills/marker-inspection.js";
import * as InstalledSkills from "../../installed-skills.js";
import { emptyLibraryState, LibraryState, type LibraryInventory } from "../../library-state.js";
import { InstalledSkill } from "../../device-state.js";
import { InventoryScanIssue } from "../../store/state-schema.js";
import { OwnershipIssue } from "../../../installed-skills/metadata.js";
import { LibraryWriter, libraryStatePath } from "../../store/library-store.js";
import { StalePlan } from "../../library-plan.js";
import { InvalidIntent } from "../../enabled-plan.js";

import { applyReviewed, planIdOf, planningState } from "../../reviewed-plan.js";
import { scanInventory, deduplicateInventoryRoots } from "../../inventory/refresh.js";

import { inventoryForRoots } from "../../inventory/read-model.js";

const ScanRoot = Schema.Struct({ harness: HarnessName, root: Schema.String });
export const RefreshInventoryIntent = Schema.TaggedStruct("RefreshInventory", {
  roots: Schema.Array(ScanRoot),
});
export type RefreshInventoryIntent = typeof RefreshInventoryIntent.Type;
const RefreshInventoryChange = Schema.Struct({
  roots: Schema.Array(ScanRoot),
  installedSkills: Schema.Array(InstalledSkill),
  unmanaged: LibraryState.fields.unmanaged.schema.schema,
  ownershipIssues: Schema.Array(OwnershipIssue),
  scanIssues: Schema.Array(InventoryScanIssue),
  next: LibraryState,
});
// Validate the plan without decoding away future state fields inside its captured observation.
export const RefreshInventoryPlan = Schema.Unknown.pipe(
  Schema.refine(
    Schema.is(
      Schema.TaggedStruct("RefreshInventory", {
        intent: RefreshInventoryIntent,
        baseRevision: Revision,
        planId: Hash,
        observedAt: Schema.String,
        change: RefreshInventoryChange,
        backups: Schema.Array(
          Schema.Struct({
            backup: Schema.Struct({ path: Schema.String, marker: OwnershipMarkerInspection }),
            copy: InstalledSkills.Folder,
            folder: InstalledSkills.Folder,
          }),
        ),
      }),
    ),
  ),
);
export type RefreshInventoryPlan = typeof RefreshInventoryPlan.Type;
interface RefreshInventoryResult {
  readonly roots: readonly (typeof ScanRoot.Type)[];
  readonly inventory: LibraryInventory;
  /** The reviewed pending-backup records that were promoted; their paths identify the before state. */
  readonly keptBackups: readonly InstalledSkills.Backup[];
}
export interface RefreshInventoryOutcome {
  readonly _tag: "RefreshInventory";
  readonly result: RefreshInventoryResult;
}

export const planInventory = Effect.fn("Library.planInventory")(function* (
  home: string,
  input: RefreshInventoryIntent,
  options: { readonly base: Snapshot; readonly observedAt?: string },
) {
  const files = yield* InstalledSkills.Service;
  const intent = yield* RefreshInventoryIntent.makeEffect(structuredClone(input)).pipe(
    Effect.mapError(() => new InvalidIntent({ detail: "invalid inventory intent" })),
  );
  const loaded = yield* planningState(home, options.base);
  const roots = deduplicateInventoryRoots(intent.roots);
  const observedAt = options.observedAt ?? new Date(yield* Clock.currentTimeMillis).toISOString();
  const state = yield* scanInventory(loaded, roots, observedAt);
  const backups: RefreshInventoryPlan["backups"][number][] = [];
  for (const installed of state.installed_skills) {
    if (installed.status !== "installed") continue;
    const copy = yield* files.inspect(installed.path);
    const marker = copy.entry._tag === "Present" ? copy.entry.facts?.marker : undefined;
    if (
      marker?.kind !== "valid" ||
      marker.marker.installed_skill_id !== installed.installed_skill_id ||
      marker.marker.skill_id !== installed.skill_id
    )
      continue;
    for (const backup of (yield* files.backups.scan(
      installed.root,
      installed.installed_skill_id,
    )).toSorted((a, b) => a.path.localeCompare(b.path)))
      backups.push({ backup, copy, folder: yield* files.inspect(backup.path) });
  }
  const reviewed = {
    _tag: "RefreshInventory" as const,
    intent: { ...intent, roots },
    baseRevision: options.base.revision,
    observedAt,
    change: {
      roots,
      installedSkills: state.installed_skills,
      unmanaged: state.unmanaged,
      ownershipIssues: state.ownershipIssues ?? [],
      scanIssues: state.scanIssues ?? [],
      next: state,
    },
    backups,
  };
  const plan: RefreshInventoryPlan = { ...reviewed, planId: yield* planIdOf(reviewed) };
  return plan;
});

/** Save observations first; only then settle the durably pending, verified backups. Never discard. */
export const applyInventory = Effect.fn("Library.applyInventory")(function* (
  home: string,
  input: RefreshInventoryPlan,
) {
  const files = yield* InstalledSkills.Service;
  const plan = structuredClone(input);
  // Validate without stripping unknown state fields; the store refuses anything it cannot save losslessly.
  yield* RefreshInventoryPlan.makeEffect(plan).pipe(
    Effect.mapError(
      () =>
        new InvalidLibraryState({ path: libraryStatePath(home), detail: "invalid inventory plan" }),
    ),
  );
  return yield* applyReviewed(
    home,
    plan,
    (base) => planInventory(home, plan.intent, { base, observedAt: plan.observedAt }),
    (again, base) =>
      Effect.gen(function* () {
        const loaded = base._tag === "Present" ? base.state : emptyLibraryState();
        yield* (yield* LibraryWriter).save(again.change.next, loaded);
        const keptBackups: InstalledSkills.Backup[] = [];
        for (const step of again.backups) {
          yield* files
            .check([step.copy, step.folder])
            .pipe(
              Effect.catchTag("Library.InstalledSkillsChanged", () =>
                Effect.fail(
                  new StalePlan({ message: "An inventory backup changed before it could be kept" }),
                ),
              ),
            );
          yield* files.backups.keep(step.backup);
          keptBackups.push(step.backup);
        }
        const outcome: RefreshInventoryOutcome = {
          _tag: "RefreshInventory",
          result: {
            roots: again.change.roots,
            inventory: inventoryForRoots(again.change.next, again.change.roots),
            keptBackups,
          },
        };
        return outcome;
      }),
  );
});
export type RefreshInventoryPlanError = Effect.Error<ReturnType<typeof planInventory>>;
export type RefreshInventoryApplyError = Effect.Error<ReturnType<typeof applyInventory>>;
