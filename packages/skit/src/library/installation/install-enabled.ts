import { Data, Clock, Effect } from "effect";
import { resolve } from "node:path";
import type { OwnershipMarker } from "../../contracts.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../../install/policy.js";
import {
  inspectOwnershipMarker,
  inspectInstalledSkill,
  withInstalledSkillMutation,
  type ManageApproval,
} from "../../install/mutation.js";
import { pathIsWithin, installDestinationPathIdentity } from "../../platform/path-identity.js";
import { UninstallConflict } from "../../failures.js";
import { repositorySelectsInstalledSkill } from "./uninstall.js";
import { installedSkillSource } from "./installed-skill-source.js";
import { LibraryStore } from "../store/library-store.js";
import type { Digest, InstallDestination } from "../../vocabulary.js";
import { enabledAt, type InstalledSkill } from "../library-state.js";
import { makeInstalledSkillId } from "../entity-ids.js";
import type { SkillId } from "../entity-ids.js";
import { currentSkillVersion, enabledSkillIds, versionBacking } from "../library-contracts.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class InstalledSkillInvalid
  extends Data.TaggedError("Library.InstalledSkillInvalid")<{
    detail: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit doctor` to inspect the Library, then retry.";
  get message(): string {
    return this.detail;
  }
}

/** Install every skill enabled at one scope into one install destination; return the copies written. Caller owns the writer lock. */
export const installEnabledSkills = Effect.fn("Library.installEnabledSkills")(function* (options: {
  target: InstallDestination;
  scope?: { kind: "global" } | { kind: "repository"; root: string };
  root: string;
  variantsPath: string;
  acceptedObservations?: ReadonlyMap<
    string,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >;
  /** The existing copies the operator chose to manage, as previewed. */
  manage?: ManageApproval;
  /** Manage unmanaged copies that already hold exactly the bytes SKIT would install. */
  manageIdentical?: boolean;
  restoreNativeDeletedSkills?: readonly string[];
  /** Bound selection, pruning and relocation to the explicitly reviewed Skills. */
  onlySkillIds?: readonly SkillId[];
}) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const scope = options.scope ?? { kind: "global" as const };
  const enabled = enabledAt(state, scope);
  if (enabled === undefined)
    return yield* new InstalledSkillInvalid({ detail: "Nothing is enabled at this scope" });

  const boundSkillIds = enabledSkillIds(state, enabled.enabled).filter(
    (id) => options.onlySkillIds === undefined || options.onlySkillIds.includes(id),
  );
  const selected = state.skills
    .filter((candidate) => boundSkillIds.includes(candidate.skill_id))
    .flatMap((skill) => {
      const version = currentSkillVersion(state, skill);
      const backing = version === undefined ? undefined : versionBacking(state, skill, version);
      return version === undefined || backing === undefined
        ? []
        : [{ skill, version, tree: backing.copy, member: backing.member }];
    });
  if (selected.length !== boundSkillIds.length)
    return yield* new InstalledSkillInvalid({
      detail: "An enabled Skill has no selected retained Version",
    });

  // Compare physical roots so a configured symlink alias cannot retire the active installation.
  const rootKeys = new Map<string, string>();
  const canonicalRoots = new Map<string, string>();
  for (const root of new Set([
    options.root,
    ...state.installed_skills
      .filter((item) => item.destination === options.target)
      .map((item) => item.root),
    ...state.repositories.map((repository) => repository.root),
  ])) {
    const identity = yield* installDestinationPathIdentity(root).pipe(
      Effect.orElseSucceed(() => ({
        comparisonKey: `path:${resolve(root)}`,
        canonicalPath: resolve(root),
      })),
    );
    rootKeys.set(root, identity.comparisonKey);
    canonicalRoots.set(root, identity.canonicalPath ?? resolve(root));
  }
  const atTarget = (installedSkill: InstalledSkill) =>
    installedSkill.destination === options.target &&
    (options.onlySkillIds === undefined ||
      options.onlySkillIds.includes(installedSkill.skill_id)) &&
    rootKeys.get(installedSkill.root) === rootKeys.get(options.root);
  const former =
    scope.kind === "global"
      ? state.installed_skills.filter(
          (installedSkill) =>
            installedSkill.destination === options.target &&
            !atTarget(installedSkill) &&
            boundSkillIds.includes(installedSkill.skill_id) &&
            !repositorySelectsInstalledSkill(state, installedSkill) &&
            !state.repositories.some(
              (repository) =>
                enabledSkillIds(state, repository.enabled).includes(installedSkill.skill_id) &&
                pathIsWithin(
                  canonicalRoots.get(repository.root) ?? repository.root,
                  canonicalRoots.get(installedSkill.root) ?? installedSkill.root,
                ),
            ),
        )
      : [];
  const uninstallMessage = (installedSkill: InstalledSkill) =>
    `Refusing to relocate modified Skill from ${installedSkill.path}`;
  // Refuse an edited former copy before creating another installation or removing any old copy.
  for (const installedSkill of former) {
    if ((yield* inspectInstalledSkill(installedSkill)).kind === "conflicted")
      return yield* new UninstallConflict({ detail: uninstallMessage(installedSkill) });
  }
  const result = yield* withInstalledSkillMutation(
    state,
    {
      rootFor: () => options.root,
      variantsPath: options.variantsPath,
      originalsPath: store.originalsPath,
      save: store.save,
    },
    (mutation) =>
      Effect.gen(function* () {
        for (const existing of mutation.state.installed_skills.filter(
          (item) => atTarget(item) && !boundSkillIds.includes(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === existing.skill_id);
          if (skill === undefined) continue;
          // A copy without SKIT's marker was never SKIT's to remove: it was already there when SKIT
          // tried to install (a conflict). Disabling drops SKIT's record and leaves it in place. A
          // managed copy edited since SKIT wrote it is refused, so no edit is lost.
          const marker = yield* inspectOwnershipMarker(existing.path);
          yield* mutation.uninstall(
            existing,
            marker.kind === "absent" ? "report" : "throw",
            `Refusing to disable ${skill.name}: ${existing.path} was edited after SKIT wrote it`,
          );
        }
        mutation.state.installed_skills.splice(
          0,
          mutation.state.installed_skills.length,
          ...mutation.state.installed_skills.filter((item) => !atTarget(item)),
        );
        const toUninstall: InstalledSkill[] = [];
        for (const item of selected) {
          const source = yield* installedSkillSource(
            mutation.state,
            store.originalsPath,
            item.skill,
            item.version,
          );
          if (source.kind === "invalid")
            return yield* new InstalledSkillInvalid({ detail: source.detail });
          const previousRows = state.installed_skills.filter(
            (candidate) => candidate.skill_id === item.skill.skill_id && atTarget(candidate),
          );
          const priorInstalledSkill = previousRows[0];
          const installedSkillId =
            priorInstalledSkill?.installed_skill_id ?? makeInstalledSkillId();
          const policy = enabled.invocation_policies?.[item.skill.skill_id];
          const installed = yield* mutation.install({
            installation: { libraryPath: source.libraryPath },
            skill: {
              skillId: item.skill.skill_id,
              skillVersionId: item.version.skill_version_id,
              name: item.skill.name,
              contentHash: item.version.validation_identity_digest,
            },
            target: options.target,
            root: options.root,
            sourcePath: source.sourcePath,
            ...(source.shared === undefined ? {} : { shared: source.shared }),
            ...(source.declaredInvocation === undefined
              ? {}
              : { declaredInvocation: source.declaredInvocation }),
            invocationIntent:
              policy === undefined ? declaredInvocationIntent : overrideInvocationIntent(policy),
            ...(priorInstalledSkill === undefined ? {} : { previous: priorInstalledSkill }),
            identity: {
              installedSkillId,
              skillId: item.skill.skill_id,
              skillVersionId: item.version.skill_version_id,
            },
            ...(options.acceptedObservations?.get(installedSkillId) === undefined
              ? {}
              : {
                  replacement: {
                    installedSkillId,
                    ...options.acceptedObservations.get(installedSkillId)!,
                  },
                }),
            ...(options.manage === undefined ? {} : { manage: options.manage }),
            ...(options.manageIdentical ? { manageIdentical: true } : {}),
            restoreNativeDeletion:
              options.restoreNativeDeletedSkills?.includes(item.skill.skill_id) ?? false,
            installedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          });
          mutation.state.installed_skills.push(installed);
          // Keep the last working copy when the new destination is blocked or locally modified.
          if (installed.status === "installed")
            toUninstall.push(
              ...former.filter((candidate) => candidate.skill_id === item.skill.skill_id),
            );
        }
        // Finish the whole installation batch before removing any former working copy.
        for (const old of toUninstall) {
          if ((yield* inspectInstalledSkill(old)).kind === "conflicted")
            return yield* new UninstallConflict({ detail: uninstallMessage(old) });
        }
        for (const old of toUninstall) {
          yield* mutation.uninstall(old, "throw", uninstallMessage(old));
          const index = mutation.state.installed_skills.findIndex(
            (candidate) => candidate.installed_skill_id === old.installed_skill_id,
          );
          if (index >= 0) mutation.state.installed_skills.splice(index, 1);
        }
        return selected.length;
      }),
  );
  return result.installed;
});
