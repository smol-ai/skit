import { Context, Effect, Layer } from "effect";
import { type InstallDestination, type InstallScope } from "@smolai/skit-core/library";
import * as Library from "@smolai/skit-core/library";
import { SkitConfiguration, pathIsWithin } from "@smolai/skit-core/platform";
import { type Hash } from "@smolai/skit-core/shared";
import { testRoots } from "./roots.js";

type ManageApproval = Extract<Library.Approval, { readonly _tag: "Manage" }>["manage"];
type OwnershipMarker = Extract<Library.Approval, { readonly _tag: "AcceptEdit" }>["marker"];

/** The configured owner's captured presence/absence; no persisted state is fabricated. */
const currentSnapshot = Effect.gen(function* () {
  const { skitHome } = yield* SkitConfiguration;
  const owner = Context.get(
    yield* Layer.build(Library.layer({ home: skitHome, roots: testRoots(skitHome) })),
    Library.Service,
  );
  return yield* owner.read;
});

/** A Library owner routed where this device already has copies, or to `add` for its scope. */
const library = (
  snapshot: Library.Snapshot,
  add?: {
    readonly destination: InstallDestination;
    readonly root: string;
    readonly scope: InstallScope;
  },
) =>
  Effect.gen(function* () {
    const { skitHome } = yield* SkitConfiguration;
    const state = snapshot._tag === "Present" ? snapshot.state : undefined;
    const roots =
      state === undefined
        ? []
        : state.installed_skills.filter(
            (row) =>
              !state.repositories.some((repository) => pathIsWithin(repository.root, row.root)),
          );
    const agents =
      add?.destination === "agents" && add.scope.kind === "global"
        ? add.root
        : roots.find((row) => row.destination === "agents")?.root;
    const claude =
      add?.destination === "claude" && add.scope.kind === "global"
        ? add.root
        : roots.find((row) => row.destination === "claude")?.root;
    return Context.get(
      yield* Layer.build(
        Library.layer({
          home: skitHome,
          roots: {
            home: skitHome,
            configHome: skitHome,
            overrides: {
              ...(agents ? { codex: [agents] } : {}),
              ...(claude ? { "claude-code": [claude] } : {}),
            },
          },
        }),
      ),
      Library.Service,
    );
  });

const count = (
  outcome: Extract<Library.Outcome, { readonly _tag: "Update" }>["result"],
  tag: Library.InstalledSkillResult["_tag"],
) => (outcome._tag === "Applied" ? outcome.copies.filter((copy) => copy._tag === tag).length : 0);

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
    const snapshot = yield* currentSnapshot;
    const copies = snapshot._tag === "Present" ? snapshot.state.installed_skills : [];
    const owner = yield* library(snapshot, {
      scope: options.scope ?? { kind: "global" },
      destination: options.target,
      root: options.root,
    });
    const approvals: Library.Approval[] = [
      ...copies
        .filter((copy) => options.restoreNativeDeletedSkills?.includes(copy.skill_id))
        .map((copy) => ({ _tag: "Restore" as const, installedSkillId: copy.installed_skill_id })),
      ...(options.manage === undefined
        ? []
        : [{ _tag: "Manage" as const, manage: options.manage }]),
      ...copies.flatMap((copy) => {
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
      plan: yield* owner.plan({ _tag: "Update" }, { base: yield* owner.read, approvals }),
    })).result;
    if (outcome._tag === "Incomplete") return yield* Effect.fail(outcome.cause);
    return count(outcome, "Installed");
  });

/** Update every installed copy where it is recorded. */
export const updateInstalledSkills = (_options: { readonly variantsPath?: string }) =>
  Effect.gen(function* () {
    const snapshot = yield* currentSnapshot;
    const owner = yield* library(snapshot);
    const outcome = (yield* owner.apply({
      _tag: "Apply",
      plan: yield* owner.plan({ _tag: "Update" }, { base: yield* owner.read }),
    })).result;
    return { installed: count(outcome, "Installed"), uninstalled: count(outcome, "Uninstalled") };
  });
