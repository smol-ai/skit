import { Effect } from "effect";
import { Library } from "../../src/library/library.js";
import { InstalledSkills } from "../../src/library/installed-skills.js";
import { CollectionRemovalMissing } from "../../src/library/installation/remove.js";
import { LibraryStore } from "../../src/library/store/library-store.js";
import type { LibraryState, InstalledSkill } from "../../src/library/library-state.js";
import type { ManageApproval } from "../../src/install/files.js";
import type { OwnershipMarker } from "../../src/contracts.js";
import type { Hash, InstallDestination } from "../../src/vocabulary.js";

/** A Library owner over this device's folders, routed only by the given active destinations. */
const library = (active?: readonly InstallDestination[]) =>
  Effect.gen(function* () {
    const files = yield* active === undefined
      ? InstalledSkills.make()
      : InstalledSkills.make({
          active: Effect.succeed(active),
          destinations: () => Effect.succeed([]),
          duplicates: {
            scan: () => Effect.succeed({ copies: [], warnings: [], roots: [] }),
          },
        });
    return yield* Library.make.pipe(Effect.provideService(InstalledSkills.Service, files));
  });

const applied = (outcome: Library.Outcome, tag: Library.CopyResult["_tag"]) =>
  outcome._tag === "Applied" ? outcome.copies.filter((copy) => copy._tag === tag).length : 0;

/** Remove a Collection through the Library owner, planned against `state`. */
export const removeCollection = (state: LibraryState, collectionId: string) =>
  Effect.gen(function* () {
    const id = state.collections.find((item) => item.collection_id === collectionId)?.collection_id;
    if (id === undefined)
      return yield* new CollectionRemovalMissing({ collection_id: collectionId });
    const owner = yield* library();
    return yield* owner.apply(
      yield* owner.plan([{ _tag: "Remove", collectionId: id }], { base: state }),
    );
  });

/** Install what is enabled at one scope into one destination, planned against the Library now. */
export const installEnabledSkills = (options: {
  readonly target: InstallDestination;
  readonly root: string;
  readonly variantsPath?: string;
  readonly scope?: { kind: "global" } | { kind: "repository"; root: string };
  readonly onlySkillIds?: readonly string[];
  readonly restoreNativeDeletedSkills?: readonly string[];
  readonly manage?: ManageApproval;
  readonly manageIdentical?: boolean;
  readonly acceptedCopies?: ReadonlyMap<
    string,
    { readonly currentHash: Hash; readonly marker: OwnershipMarker }
  >;
}) =>
  Effect.gen(function* () {
    const state = yield* (yield* LibraryStore).load;
    const ids = (listed: readonly string[] | undefined) =>
      state.skills
        .filter((skill) => listed?.includes(skill.skill_id))
        .map((skill) => skill.skill_id);
    const owner = yield* library();
    const outcome = yield* owner.apply(
      yield* owner.plan(
        [
          {
            _tag: "Install",
            scope: options.scope ?? { kind: "global" },
            destination: { destination: options.target, root: options.root },
            ...(options.onlySkillIds === undefined ? {} : { only: ids(options.onlySkillIds) }),
            restoreDeleted: ids(options.restoreNativeDeletedSkills),
            manageIdentical: options.manageIdentical ?? false,
            ...(options.manage === undefined ? {} : { manage: options.manage }),
            acceptedCopies: state.installed_skills.flatMap((copy) => {
              const accepted = options.acceptedCopies?.get(copy.installed_skill_id);
              return accepted === undefined
                ? []
                : [{ installedSkillId: copy.installed_skill_id, ...accepted }];
            }),
          },
        ],
        { base: state },
      ),
    );
    return applied(outcome, "Installed");
  });

/**
 * Uninstall copies no setting asks for, with these destinations active. An update of every copy
 * also uninstalls what nothing enables; an update of one Collection, only what is inactive.
 */
export const uninstallLeftovers = (options: {
  readonly activeTargets: readonly InstallDestination[];
  readonly inactiveOnly?: boolean;
  readonly variantsPath?: string;
}) =>
  Effect.gen(function* () {
    const state = yield* (yield* LibraryStore).load;
    const collectionId = state.collections[0]?.collection_id;
    const owner = yield* library(options.activeTargets);
    const outcome = yield* owner.apply(
      yield* owner.plan(
        [
          options.inactiveOnly && collectionId !== undefined
            ? { _tag: "Update", collectionId }
            : { _tag: "Update" },
        ],
        { base: state },
      ),
    );
    return applied(outcome, "Uninstalled");
  });

/** Uninstall recorded copies, planned against `state`. */
export const uninstallCopies = (state: LibraryState, copies: readonly InstalledSkill[]) =>
  Effect.gen(function* () {
    const owner = yield* library();
    return yield* owner.apply(
      yield* owner.plan(
        [
          {
            _tag: "Uninstall",
            copies: copies.map((copy) => copy.installed_skill_id),
            drop: [],
          },
        ],
        { base: state },
      ),
    );
  });
