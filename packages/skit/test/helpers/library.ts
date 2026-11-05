import { Context, Effect, FileSystem, Layer } from "effect";
import { join, resolve } from "node:path";
import * as Library from "../../src/library/library.js";
import { CollectionRemovalMissing } from "../../src/library/installation/remove.js";
import { emptyLibraryState, type LibraryState } from "../../src/library/library-state.js";
import { type InstalledSkill } from "../../src/library/device-state.js";
import { snapshotOf } from "../../src/library/snapshot.js";

import type { ManageApproval } from "../../src/installed-skills/files.js";
import type { OwnershipMarker } from "../../src/installed-skills/ownership-marker.js";
import type { Hash } from "../../src/shared/hash.js";
import type { InstallDestination } from "../../src/installed-skills/destination.js";
import type { InstallScope } from "../../src/library/scope.js";

/** Real public owner construction; fixture options supply device roots, never adapters. */
const library = (
  home: string,
  state: LibraryState,
  options: {
    readonly active?: readonly InstallDestination[];
    readonly add?: {
      readonly destination: InstallDestination;
      readonly root: string;
      readonly scope: InstallScope;
    };
  } = {},
) =>
  Effect.gen(function* () {
    let routing: Library.Routing = { _tag: "Recorded" };
    if (options.add !== undefined || options.active !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const physical = (path: string) =>
        fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
      const repositories = yield* Effect.forEach(state.repositories, (repository) =>
        physical(repository.root),
      );
      const roots = new Map<InstallDestination, string>();
      for (const copy of state.installed_skills) {
        const path = yield* physical(copy.root);
        if (!repositories.some((root) => path === root || path.startsWith(`${root}/`)))
          roots.set(copy.destination, copy.root);
      }
      if (options.add?.scope.kind === "global")
        roots.set(options.add.destination, options.add.root);
      const deviceHome = join(home, "test-device");
      const active = options.active ?? [...roots.keys()];
      routing = {
        _tag: "Configured",
        home: deviceHome,
        configHome: join(deviceHome, ".config"),
        overrides: {
          codex: [roots.get("agents") ?? join(deviceHome, ".agents", "skills")],
          ...(active.includes("claude")
            ? { "claude-code": [roots.get("claude") ?? join(deviceHome, ".claude", "skills")] }
            : {}),
        },
      };
    }
    return Context.get(yield* Layer.build(Library.layer({ home, routing })), Library.Service);
  });

const applied = (
  outcome: Extract<Library.Outcome, { readonly _tag: "Update" }>["result"],
  tag: Library.InstalledSkillResult["_tag"],
) => (outcome._tag === "Applied" ? outcome.copies.filter((copy) => copy._tag === tag).length : 0);

/** Keep the known-present, deliberately stale state supplied by removal safety tests. */
export const removeCollection = (home: string, state: LibraryState, collectionId: string) =>
  Effect.gen(function* () {
    const id = state.collections.find((item) => item.collection_id === collectionId)?.collection_id;
    if (id === undefined)
      return yield* new CollectionRemovalMissing({ collection_id: collectionId });
    const owner = yield* library(home, state);
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
  readonly home: string;
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
    const { home } = options;
    const snapshot = yield* (yield* library(home, emptyLibraryState())).read;
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
  readonly home: string;
  readonly target: InstallDestination;
  readonly root: string;
  readonly approvals: readonly Library.Approval[];
}) =>
  Effect.gen(function* () {
    const { home } = options;
    const snapshot = yield* (yield* library(home, emptyLibraryState())).read;
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
  readonly home: string;
  readonly activeTargets: readonly InstallDestination[];
  readonly variantsPath?: string;
}) =>
  Effect.gen(function* () {
    const { home } = options;
    const snapshot = yield* (yield* library(home, emptyLibraryState())).read;
    const state = snapshot._tag === "Present" ? snapshot.state : emptyLibraryState();
    const owner = yield* library(home, state, { active: options.activeTargets });
    const outcome = (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan({ _tag: "Update" }, { base: snapshot }),
    })).result;
    return applied(outcome, "Uninstalled");
  });

/** Keep the known-present, deliberately stale state supplied by backup safety tests. */
export const uninstallCopies = (
  home: string,
  state: LibraryState,
  copies: readonly InstalledSkill[],
) =>
  Effect.gen(function* () {
    const owner = yield* library(home, state);
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
