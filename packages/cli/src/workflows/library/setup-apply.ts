import { join } from "node:path";
import { Effect } from "effect";
import {
  LibraryChanged,
  LibraryStore,
  libraryStateRevision,
  withLibraryWriter,
  type Digest,
} from "@smolai/skit-core";
import type { LocalAdoptionOptions } from "./local-adoption.js";
import { revalidateSetupPlan, saveSetupMachineConfig, type SetupOptions } from "./setup.js";
import type { SetupKnownSourceSelection } from "./setup-contract.js";
import type { SetupCopySelection } from "./setup-decisions.js";
import { applySetupExistingBindings } from "./setup-existing-binding.js";
import { applySetupLocalCustody } from "./setup-local-custody.js";
import { applySetupObservedCollections } from "./setup-observed-collections.js";
import type { PreparedRecoveryMoves } from "../../library-application/recovery-moves.js";

/** What the user reviewed and approved: the plan ID they saw and the selections they made. */
export interface SetupApproval {
  readonly setup: SetupOptions;
  readonly planId: Digest;
  /** Save the discovery roots and repository decisions this setup observes. */
  readonly persistRoots: boolean;
  readonly imports: readonly SetupKnownSourceSelection[];
  readonly bindings: readonly SetupCopySelection[];
  readonly custody: readonly SetupCopySelection[];
  readonly removals: PreparedRecoveryMoves;
}

export interface SetupApplyOptions {
  readonly adoption: LocalAdoptionOptions;
  /** Runs each stage under its progress message. */
  readonly withStatus: <A, E, R>(
    message: string,
    stage: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Apply an approved setup plan from one scan taken under the Library writer.
 *
 * That scan must reproduce the approved plan ID, which covers the observed copies and the Library
 * revision. No stage observes again, so consent never moves to a plan the user did not review;
 * each stage still checks the identity of what it touches immediately before touching it. Every
 * Library publication must build on the approved revision or on this apply's previous publication.
 * Additive stages run first and removals last, so a failed or stale additive stage removes nothing.
 */
export const applySetupPlan = Effect.fn("Setup.applyPlan")(
  function* (options: SetupApplyOptions, approval: SetupApproval) {
    const scan = yield* options.withStatus(
      "Revalidating the approved setup plan",
      revalidateSetupPlan(approval.setup, approval.planId),
    );
    let current = scan.observed;
    const store = yield* LibraryStore;
    let revision = libraryStateRevision(scan.library);
    const warnings: { name: string; message: string }[] = [];
    const recoveryDirectories: string[] = [];
    yield* Effect.gen(function* () {
      if (
        approval.persistRoots ||
        ((approval.imports.length || approval.custody.length) && !current.machineConfig.machineId)
      ) {
        const saved = yield* options.withStatus(
          current.machineConfig.machineId
            ? "Saving this machine's discovery roots"
            : "Creating this machine's Library identity",
          saveSetupMachineConfig({ ...approval.setup, persistRoots: true }),
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
      if (approval.imports.length) {
        const collections = new Set(approval.imports.map((selection) => selection.groupKey)).size;
        yield* options.withStatus(
          `Importing ${collections} installed Collection${collections === 1 ? "" : "s"} (${approval.imports.length} Skill${approval.imports.length === 1 ? "" : "s"})`,
          applySetupObservedCollections({ setup: approval.setup }, current, approval.imports),
        );
      }
      if (approval.bindings.length) {
        const reconnects = approval.bindings.filter(
          (selection) => selection.duplicateAction !== "retain-only",
        ).length;
        const applied = yield* options.withStatus(
          reconnects
            ? `Reconnecting ${reconnects} existing Library match${reconnects === 1 ? "" : "es"}`
            : "Keeping existing Library matches without enabling",
          applySetupExistingBindings(options.adoption, current, approval.bindings),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
      if (approval.custody.length) {
        const names =
          approval.custody.length <= 5
            ? `: ${approval.custody.map((selection) => selection.name).join(", ")}`
            : "";
        const applied = yield* options.withStatus(
          `Taking custody of ${approval.custody.length} local Skill${approval.custody.length === 1 ? "" : "s"}${names}`,
          applySetupLocalCustody(options.adoption, current, approval.custody),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
    }).pipe(
      Effect.provideService(LibraryStore, {
        ...store,
        publish: (next, base) =>
          libraryStateRevision(base) === revision
            ? Effect.tap(store.publish(next, base), () =>
                Effect.sync(() => {
                  revision = libraryStateRevision(next);
                }),
              )
            : Effect.fail(new LibraryChanged({ path: join(store.home, "state.json") })),
      }),
    );
    if (approval.removals.entries.length) {
      if (libraryStateRevision(yield* store.load) !== revision)
        return yield* new LibraryChanged({ path: join(store.home, "state.json") });
      yield* options.withStatus(
        `Removing ${approval.removals.entries.length} installed cop${approval.removals.entries.length === 1 ? "y" : "ies"}`,
        approval.removals.apply(),
      );
    }
    return { observed: current, warnings, recoveryDirectories };
  },
  (effect) => withLibraryWriter(effect),
);
