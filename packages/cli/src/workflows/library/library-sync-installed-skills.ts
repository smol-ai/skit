import { Effect } from "effect";
import {
  LibraryState,
  LibraryManifest,
  LibraryStore,
  LibraryChanged,
  blendRestoredState,
  withLibraryWriter,
  Library,
  InstalledSkills,
  InstalledSkillInvalid,
  type InstallDestination,
} from "@smolai/skit-core";
import {
  previewSyncInstalledSkills,
  type SyncInstalledSkillsPreview,
} from "@smolai/skit-core/library/session";
import { existingRepositorySkillsDirectory } from "@smolai/skit-core/library/routing";

const targets = ["agents", "claude"] as const;

/**
 * This device's skill folders as sync routes them: global copies at `rootFor`'s roots, repository
 * copies at the routes they already use. Without `rootFor`, every destination counts as active.
 */
export const syncInstalledSkills = Effect.fn("Library.sync.installedSkills")(function* (
  state: LibraryState,
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
) {
  const active =
    rootFor === undefined
      ? [...targets]
      : targets.filter((target) => rootFor(target) !== undefined);
  return yield* InstalledSkills.make({
    active: Effect.succeed(active),
    destinations: (scope) =>
      Effect.succeed(
        active.flatMap((destination) => {
          const root =
            scope.kind === "global"
              ? rootFor?.(destination)
              : existingRepositorySkillsDirectory(state, scope.root, destination);
          return root === undefined ? [] : [{ destination, root }];
        }),
      ),
    duplicates: {
      scan: () =>
        Effect.fail(new InstalledSkillInvalid({ detail: "Sync does not scan for duplicates" })),
    },
  });
});

/** Every copy SKIT installed, brought in line with what is enabled, as sync routes them. */
export const updateSyncInstalledSkills = Effect.fn("Library.sync.updateInstalledSkills")(function* (
  rootFor: ((target: InstallDestination) => string | undefined) | undefined,
) {
  const current = yield* (yield* LibraryStore).load;
  const library = yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, yield* syncInstalledSkills(current, rootFor)),
  );
  const outcome = yield* library.apply(yield* library.plan({ _tag: "Update" }, { base: current }));
  const copies = outcome._tag === "Applied" ? outcome.copies : [];
  return {
    installed: copies.filter((copy) => copy._tag === "Installed").length,
    uninstalled: copies.filter((copy) => copy._tag === "Uninstalled").length,
  };
});

/**
 * Keep old references durable until portable state and ancestry can be saved together.
 * Saves only onto `current`, the state sync planned from, and returns the state it saved.
 */
const uninstallForSync = Effect.fn("Library.sync.uninstallForSync")(function* (
  plan: SyncInstalledSkillsPreview,
  current: LibraryState,
) {
  const store = yield* LibraryStore;
  if (plan.retire.length === 0) return { uninstalled: 0, state: current };
  const library = yield* Library.Service;
  const outcome = yield* library.apply(
    yield* library.plan(
      { _tag: "Uninstall", copies: plan.retire, drop: plan.remove },
      {
        base: current,
      },
    ),
  );
  return {
    uninstalled:
      outcome._tag === "Applied"
        ? outcome.copies.filter((copy) => copy._tag === "Uninstalled").length
        : 0,
    state: yield* store.load,
  };
});

/** Prepare this device's local transition before remote publication; keep mutation records private. */
export const prepareSyncDeviceTransition = Effect.fn("Library.sync.prepareDeviceTransition")(
  function* (options: {
    readonly current: LibraryState | undefined;
    readonly aligned: LibraryState;
    readonly baseline?: LibraryState;
    readonly manifest: LibraryManifest;
    readonly rootFor: ((target: InstallDestination) => string | undefined) | undefined;
    readonly deferDeviceConflicts?: boolean;
  }) {
    const store = yield* LibraryStore;
    const home = store.home;
    const { current, aligned } = options;
    // An absent Library has no local copies to protect. A pull may accept remote Bindings
    // without a selected Version, which planning an empty device would otherwise reject.
    const plan =
      current === undefined
        ? undefined
        : yield* previewSyncInstalledSkills(
            current,
            aligned,
            options.manifest,
            options.rootFor,
            options.deferDeviceConflicts ?? false,
          );
    if (plan?.conflicts.length) return { _tag: "Conflicted" as const, conflicts: plan.conflicts };
    const baseline = current ?? options.baseline ?? aligned;
    return {
      _tag: "Ready" as const,
      issues: plan?.issues ?? [],
      saveRestored: Effect.fn("Library.sync.saveDeviceTransition")(function* (
        restored: LibraryState,
        ancestry: NonNullable<LibraryState["sync_ancestry"]>,
      ) {
        const store = yield* LibraryStore;
        if (store.home !== home) return yield* new LibraryChanged({ path: store.statePath });
        return yield* withLibraryWriter(
          Effect.gen(function* () {
            const uninstallResult =
              plan === undefined
                ? { uninstalled: 0, state: baseline }
                : yield* uninstallForSync(plan, baseline);
            const blended = yield* blendRestoredState(
              { ...aligned, installed_skills: [...(plan?.projections ?? [])] },
              restored,
            );
            // Save content and its accepted base together, replacing exactly the state retirement
            // saved (or the original baseline when no retirement was required).
            yield* store.save({ ...blended, sync_ancestry: ancestry }, uninstallResult.state);
            return uninstallResult.uninstalled;
          }),
        );
      }),
    };
  },
);
