import { Effect } from "effect";
import {
  InstalledSkills,
  Library,
  LibraryStore,
  type Hash,
  type InstallDestination,
  type ManageApproval,
  type OwnershipMarker,
} from "@smolai/skit-core";

/** A Library owner over this device's folders; with destinations active, but none routed. */
const library = (active?: readonly InstallDestination[]) =>
  Effect.gen(function* () {
    const files = yield* active === undefined
      ? InstalledSkills.make()
      : InstalledSkills.make({
          active: Effect.succeed(active),
          destinations: () => Effect.succeed([]),
          duplicates: { scan: () => Effect.succeed({ copies: [], warnings: [], roots: [] }) },
        });
    return yield* Library.make.pipe(Effect.provideService(InstalledSkills.Service, files));
  });

const count = (outcome: Library.Outcome, tag: Library.CopyResult["_tag"]) =>
  outcome._tag === "Applied" ? outcome.copies.filter((copy) => copy._tag === tag).length : 0;

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
    return count(outcome, "Installed");
  });

/** Update every copy with every destination active but none routed: uninstalls leftovers. */
export const updateInstalledSkills = (_options: { readonly variantsPath?: string }) =>
  Effect.gen(function* () {
    const state = yield* (yield* LibraryStore).load;
    const owner = yield* library(["agents", "claude"]);
    const outcome = yield* owner.apply(yield* owner.plan([{ _tag: "Update" }], { base: state }));
    return { installed: count(outcome, "Installed"), uninstalled: count(outcome, "Uninstalled") };
  });
