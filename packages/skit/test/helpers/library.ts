import { make as makeLibrary } from "../../src/library/internal/runtime.js";
import { Effect } from "effect";
import { Library } from "../../src/library/library.js";
import { InstalledSkills } from "../../src/library/installed-skills.js";
import { CollectionRemovalMissing } from "../../src/library/installation/remove.js";
import { emptyLibraryState } from "../../src/library/library-state.js";
import { inspectLocalLibraryState, LibraryWriter } from "../../src/library/store/library-store.js";
import { snapshotOf } from "../../src/library/snapshot.js";
import type { LibraryState, InstalledSkill } from "../../src/library/library-state.js";
import type { ManageApproval } from "../../src/install/files.js";
import type { OwnershipMarker } from "../../src/contracts.js";
import type { Hash, InstallDestination, InstallScope } from "../../src/vocabulary.js";
import { canonicalJson } from "../../src/shared/json.js";

/**
 * A Library owner routed where this device already has copies, or to `add` for its destination
 * and scope; only `active` destinations count when given.
 */
const library = (
  home: string,
  state: LibraryState,
  options: {
    readonly active?: readonly InstallDestination[];
    readonly add?: InstalledSkills.Destination & { readonly scope: InstallScope };
  } = {},
) =>
  Effect.gen(function* () {
    const recorded = yield* InstalledSkills.recordedRouting(state);
    const { add, active } = options;
    const files = yield* InstalledSkills.make({
      ...recorded,
      ...(active === undefined ? {} : { active: Effect.succeed(active) }),
      destinations: (scope) =>
        Effect.map(recorded.destinations(scope), (targets) =>
          (active ?? ["agents", "claude"]).flatMap((destination) =>
            add !== undefined &&
            add.destination === destination &&
            canonicalJson(add.scope) === canonicalJson(scope)
              ? [{ destination, root: add.root }]
              : targets.filter((target) => target.destination === destination),
          ),
        ),
    });
    return yield* makeLibrary(home).pipe(Effect.provideService(InstalledSkills.Service, files));
  });

const applied = (
  outcome: Extract<Library.Outcome, { readonly _tag: "Update" }>["result"],
  tag: Library.InstalledSkillResult["_tag"],
) => (outcome._tag === "Applied" ? outcome.copies.filter((copy) => copy._tag === tag).length : 0);

/** Keep the known-present, deliberately stale state supplied by removal safety tests. */
export const removeCollection = (state: LibraryState, collectionId: string) =>
  Effect.gen(function* () {
    const id = state.collections.find((item) => item.collection_id === collectionId)?.collection_id;
    if (id === undefined)
      return yield* new CollectionRemovalMissing({ collection_id: collectionId });
    const owner = yield* library((yield* LibraryWriter).home, state);
    return (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan(
        { _tag: "Remove", collectionId: id },
        { base: snapshotOf({ present: true, state }) },
      ),
    })).result;
  });

/** Update every installed copy, with what is enabled at `scope` also routed to this destination. */
export const installEnabledSkills = (options: {
  readonly target: InstallDestination;
  readonly root: string;
  readonly variantsPath?: string;
  readonly scope?: InstallScope;
  readonly restoreNativeDeletedSkills?: readonly string[];
  readonly manage?: ManageApproval;
  readonly acceptedCopies?: ReadonlyMap<
    string,
    { readonly currentHash: Hash; readonly marker: OwnershipMarker }
  >;
}) =>
  Effect.gen(function* () {
    const { home } = yield* LibraryWriter;
    const snapshot = snapshotOf(yield* inspectLocalLibraryState(home));
    const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
    const owner = yield* library(home, state, {
      add: {
        scope: options.scope ?? { kind: "global" },
        destination: options.target,
        root: options.root,
      },
    });
    const approvals: Library.Approval[] = [
      ...state.installed_skills
        .filter((copy) => options.restoreNativeDeletedSkills?.includes(copy.skill_id))
        .map((copy) => ({ _tag: "Restore" as const, installedSkillId: copy.installed_skill_id })),
      ...(options.manage === undefined
        ? []
        : [{ _tag: "Manage" as const, manage: options.manage }]),
      ...state.installed_skills.flatMap((copy) => {
        const accepted = options.acceptedCopies?.get(copy.installed_skill_id);
        return accepted === undefined
          ? []
          : [
              {
                _tag: "AcceptEdit" as const,
                installedSkillId: copy.installed_skill_id,
                ...accepted,
              },
            ];
      }),
    ];
    const outcome = (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan({ _tag: "Update" }, { base: snapshot, approvals }),
    })).result;
    if (outcome._tag === "Incomplete") return yield* Effect.fail(outcome.cause);
    return applied(outcome, "Installed");
  });

/**
 * Plan an update of every installed copy, with what is enabled globally also routed to this
 * destination, and the apply of exactly that plan.
 */
export const planUpdate = (options: {
  readonly target: InstallDestination;
  readonly root: string;
  readonly approvals: readonly Library.Approval[];
}) =>
  Effect.gen(function* () {
    const { home } = yield* LibraryWriter;
    const snapshot = snapshotOf(yield* inspectLocalLibraryState(home));
    const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
    const owner = yield* library(home, state, {
      add: { scope: { kind: "global" }, destination: options.target, root: options.root },
    });
    const plan = yield* owner.plan(
      { _tag: "Update" },
      { base: snapshot, approvals: options.approvals },
    );
    return { plan, apply: owner.apply({ _tag: "Apply", plan: plan }) };
  });

/** Update every installed copy with only these destinations active. */
export const uninstallLeftovers = (options: {
  readonly activeTargets: readonly InstallDestination[];
  readonly variantsPath?: string;
}) =>
  Effect.gen(function* () {
    const { home } = yield* LibraryWriter;
    const snapshot = snapshotOf(yield* inspectLocalLibraryState(home));
    const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
    const owner = yield* library(home, state, { active: options.activeTargets });
    const outcome = (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan({ _tag: "Update" }, { base: snapshot }),
    })).result;
    return applied(outcome, "Uninstalled");
  });

/** Keep the known-present, deliberately stale state supplied by backup safety tests. */
export const uninstallCopies = (state: LibraryState, copies: readonly InstalledSkill[]) =>
  Effect.gen(function* () {
    const owner = yield* library((yield* LibraryWriter).home, state);
    return (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan(
        {
          _tag: "Uninstall",
          copies: copies.map((copy) => copy.installed_skill_id),
          drop: [],
        },
        { base: snapshotOf({ present: true, state }) },
      ),
    })).result;
  });
