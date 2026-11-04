import { Clock, Effect, Schema } from "effect";
import { Hash, HarnessName } from "../../../vocabulary.js";
import { sha256Hash } from "../../../shared/hash.js";
import { canonicalJson } from "../../../shared/json.js";
import { InvalidLibraryState } from "../../../failures.js";
import { OwnershipMarkerInspection } from "../../../install/files.js";
import { InstalledSkills } from "../../installed-skills.js";
import { emptyLibraryState, InstalledSkill, LibraryState } from "../../library-state.js";
import { InventoryScanIssue, OwnershipIssue } from "../../store/state-schema.js";
import { LibraryStore, withLibraryWriter } from "../../store/library-store.js";
import { StalePlan } from "../../library-plan.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { Revision, snapshotOf, type Snapshot } from "../../snapshot.js";
import { scanInventory, deduplicateInventoryRoots } from "../../inventory/refresh.js";

const ScanRoot = Schema.Struct({ harness: HarnessName, root: Schema.String });
export const RefreshInventoryIntent = Schema.TaggedStruct("RefreshInventory", {
  roots: Schema.Array(ScanRoot),
});
export type RefreshInventoryIntent = typeof RefreshInventoryIntent.Type;
export const RefreshInventoryChange = Schema.Struct({
  roots: Schema.Array(ScanRoot),
  installedSkills: Schema.Array(InstalledSkill),
  unmanaged: LibraryState.fields.unmanaged,
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
        baseRevision: Schema.String,
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
export interface RefreshInventoryResult {
  readonly roots: readonly (typeof ScanRoot.Type)[];
  readonly state: LibraryState;
  /** The reviewed pending-backup records that were promoted; their paths identify the before state. */
  readonly keptBackups: readonly InstalledSkills.Backup[];
}
export interface RefreshInventoryOutcome {
  readonly _tag: "RefreshInventory";
  readonly result: RefreshInventoryResult;
}

const planHash = (plan: Omit<RefreshInventoryPlan, "planId">) =>
  sha256Hash(new TextEncoder().encode(canonicalJson(plan)));

export const planInventory = Effect.fn("Library.planInventory")(function* (
  input: RefreshInventoryIntent,
  options: { readonly base: Snapshot; readonly observedAt?: string },
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const intent = yield* RefreshInventoryIntent.makeEffect(structuredClone(input)).pipe(
    Effect.mapError(() => new InvalidIntent({ detail: "invalid inventory intent" })),
  );
  const base = structuredClone(options.base);
  const loaded = base._tag === "Present" ? base.state : emptyLibraryState();
  yield* LibraryState.makeEffect(loaded).pipe(
    Effect.mapError(
      () =>
        new InvalidLibraryState({ path: store.statePath, detail: "invalid inventory snapshot" }),
    ),
  );
  const actual = snapshotOf(
    base._tag === "Present" ? { present: true, state: loaded } : { present: false },
  ).revision;
  if (base.revision !== actual)
    return yield* new StalePlan({
      message: "The displayed inventory snapshot changed",
      expected: base.revision,
      actual,
    });
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
    baseRevision: base.revision,
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
  const plan: RefreshInventoryPlan = { ...reviewed, planId: yield* planHash(reviewed) };
  return plan;
});

/** Save observations first; only then settle the durably pending, verified backups. Never discard. */
export const applyInventory = Effect.fn("Library.applyInventory")(function* (
  input: RefreshInventoryPlan,
) {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const plan = structuredClone(input);
  // Validate without stripping unknown state fields; the store refuses anything it cannot save losslessly.
  yield* RefreshInventoryPlan.makeEffect(plan).pipe(
    Effect.mapError(
      () => new InvalidLibraryState({ path: store.statePath, detail: "invalid inventory plan" }),
    ),
  );
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const base = snapshotOf(yield* store.inspect);
      if (base.revision !== plan.baseRevision)
        return yield* new StalePlan({
          message: "Library changed after inventory was previewed",
          expected: Revision(plan.baseRevision),
          actual: base.revision,
        });
      const again = yield* planInventory(plan.intent, { base, observedAt: plan.observedAt });
      const { planId, ...reviewed } = plan;
      if (planId !== (yield* planHash(reviewed)) || planId !== again.planId)
        return yield* new StalePlan({
          message: "Inventory folders changed after this scan was previewed",
        });
      const loaded = base._tag === "Present" ? base.state : emptyLibraryState();
      yield* store.save(again.change.next, loaded);
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
        result: { roots: again.change.roots, state: again.change.next, keptBackups },
      };
      return outcome;
    }),
  );
});
export type RefreshInventoryPlanError = Effect.Error<ReturnType<typeof planInventory>>;
export type RefreshInventoryApplyError = Effect.Error<ReturnType<typeof applyInventory>>;
