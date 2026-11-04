import { Context, Effect, FileSystem, Layer } from "effect";
import type { Digest } from "effect/crypto";
import { InstalledSkills } from "./installed-skills.js";
import {
  LibraryStore,
  withLibraryWriter,
  type LibraryStateReadError,
} from "./store/library-store.js";
import { libraryStateRevision, type LibraryState } from "./library-state.js";
import { snapshotOf, type Snapshot } from "./snapshot.js";
import { setup, type SetupError, type SetupResult, type SupportedSetupStep } from "./setup.js";
import {
  importCollection,
  importAuthoredCollection,
  importEdit,
  type AuthoredImport,
  type EditImport,
  type ImportAuthoredCollectionError,
  type ImportCollectionError,
  type ImportEditError,
  type ImportedCollection,
  type ImportedEdit,
  type ImportRequest,
} from "./import-collection.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { ApplyError, Approval, Intent, Outcome, Plan, PlanError } from "./library-plan.js";
import { planChanges } from "./plan-changes.js";
import { apply } from "./apply-plan.js";
export * from "./library-plan.js";
export { reviewInstalledSkillChanges } from "./installed-skill-review.js";
export {
  InvalidIntent,
  calculateEnabled,
  enabledCollections,
  uniqueInstallScopes,
  sameInstallScope,
} from "./enabled-plan.js";
export type { Subject, Invocation, EnabledCollection, SetupApproval } from "./enabled-plan.js";

export { Revision, type Snapshot } from "./snapshot.js";
export type { SetupError, SetupResult, SetupStepResult, SupportedSetupStep } from "./setup.js";

export interface Interface {
  /**
   * One read. Never writes: a legacy state.json was migrated when the layer was built, and a read
   * refuses any state.json that is not the current version.
   */
  readonly read: Effect.Effect<Snapshot, LibraryStateReadError>;
  /**
   * Plan against the Library the front end showed, never a fresh read: apply refuses the plan if
   * the Library has changed since.
   */
  readonly plan: (
    intent: Intent,
    options: { readonly base: LibraryState; readonly approvals?: readonly Approval[] },
  ) => Effect.Effect<Plan, PlanError>;
  readonly apply: (plan: Plan) => Effect.Effect<Outcome, ApplyError>;
  /**
   * Store a Source's files as a Collection Version and save it. Nothing to preview or recheck: it
   * touches no skill folders, and what it imports exists only while the fetched Source does.
   */
  readonly import: {
    readonly collection: (
      request: ImportRequest,
    ) => Effect.Effect<ImportedCollection, ImportCollectionError>;
    readonly authored: (
      request: AuthoredImport,
    ) => Effect.Effect<ImportedCollection, ImportAuthoredCollectionError>;
    /** An edited copy, as a new Version of its Skill. */
    readonly edit: (request: EditImport) => Effect.Effect<ImportedEdit, ImportEditError>;
  };
  /**
   * Save the steps in state.json as one Pending operation, then run them in order, removals last,
   * marking each Done. Failures before the steps are saved are SetupError and write nothing;
   * after, every failure is a Stopped result with its operationId. Never rolls back on its own.
   */
  readonly setup: (
    steps: readonly SupportedSetupStep[],
    options: { readonly base: Snapshot },
  ) => Effect.Effect<SetupResult, SetupError>;
}
export class Service extends Context.Service<Service, Interface>()("skit/library/Library") {}

export const make = Effect.gen(function* () {
  const store = yield* LibraryStore;
  const files = yield* InstalledSkills.Service;
  const writer = yield* Effect.context<FileSystem.FileSystem>();
  const importing = yield* Effect.context<TreeRequirements | Digest.Digest>();
  /** Every import holds the Library writer, and its staging ends with the import. */
  const owned = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withLibraryWriter(Effect.scoped(effect)).pipe(
      Effect.provideService(LibraryStore, store),
      Effect.provide(writer),
      Effect.provide(importing),
    );

  return Service.of({
    read: Effect.map(store.inspect, snapshotOf),
    plan: Effect.fn("Library.plan")(function* (intent, options) {
      const base = structuredClone(options.base);
      const approvals = structuredClone(options.approvals ?? []);
      const reviewed = structuredClone(intent);
      const planned = yield* Effect.scoped(planChanges(base, reviewed, approvals)).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
      );
      return {
        baseRevision: libraryStateRevision(base),
        intent: reviewed,
        approvals,
        routes: planned.routes,
        folders: planned.folders,
        next: planned.next,
        changes: [...planned.enabled.map(({ change }) => change), ...planned.changes],
      };
    }),
    apply: (plan) =>
      apply(plan).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provideService(InstalledSkills.Service, files),
        Effect.provide(writer),
      ),
    import: {
      collection: (request) => owned(importCollection(request)),
      authored: (request) => owned(importAuthoredCollection(request)),
      edit: (request) => owned(importEdit(request)),
    },
    setup: (steps, options) =>
      setup(steps, options).pipe(
        Effect.provideService(LibraryStore, store),
        Effect.provide(writer),
        Effect.provide(importing),
      ),
  });
});
export const layer = Layer.effect(Service, make);
export * as Library from "./library.js";
