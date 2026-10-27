import { Data, Clock, Effect } from "effect";
import { resolve } from "node:path";
import type { OwnershipMarker } from "../../contracts.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../../projection/policy.js";
import {
  inspectOwnershipMarker,
  inspectInstalledSkill,
  withInstalledSkillMutation,
  type ManageApproval,
} from "../../projection/mutation.js";
import { pathIsWithin, installDestinationPathIdentity } from "../../platform/path-identity.js";
import { InstalledSkillRetireConflict } from "../../failures.js";
import { repositorySelectsInstalledSkill } from "./retire-unbound.js";
import { installedSkillSource } from "./installed-skill-source.js";
import { LibraryStore } from "../store/library-store.js";
import type { Digest, InstallDestination } from "../../vocabulary.js";
import { scopeBinding, type InstalledSkill } from "../library-state.js";
import { makeInstalledSkillId } from "../entity-ids.js";
import type { SkillId } from "../entity-ids.js";
import { bindingSkillIds, currentSkillVersion, versionBacking } from "../library-contracts.js";
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

/** Reconcile one Binding; return the number of Skill copies written. Caller owns the writer lock. */
export const projectBinding = Effect.fn("Library.projectBinding")(function* (options: {
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
  const binding = scopeBinding(state, scope);
  if (binding === undefined)
    return yield* new InstalledSkillInvalid({ detail: "Binding is missing" });

  const boundSkillIds = bindingSkillIds(state, binding).filter(
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
      detail: "Binding selects a Skill without a selected retained Version",
    });

  // Compare physical roots so a configured symlink alias cannot retire the active installation.
  const rootKeys = new Map<string, string>();
  const canonicalRoots = new Map<string, string>();
  for (const root of new Set([
    options.root,
    ...state.projections.filter((item) => item.target === options.target).map((item) => item.root),
    ...state.local_bindings.map((item) => item.scope.root),
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
  const atTarget = (projection: InstalledSkill) =>
    projection.target === options.target &&
    (options.onlySkillIds === undefined || options.onlySkillIds.includes(projection.skill_id)) &&
    rootKeys.get(projection.root) === rootKeys.get(options.root);
  const former =
    scope.kind === "global"
      ? state.projections.filter(
          (projection) =>
            projection.target === options.target &&
            !atTarget(projection) &&
            boundSkillIds.includes(projection.skill_id) &&
            !repositorySelectsInstalledSkill(state, projection) &&
            !state.local_bindings.some(
              (local) =>
                bindingSkillIds(state, local).includes(projection.skill_id) &&
                pathIsWithin(
                  canonicalRoots.get(local.scope.root) ?? local.scope.root,
                  canonicalRoots.get(projection.root) ?? projection.root,
                ),
            ),
        )
      : [];
  const retirementMessage = (projection: InstalledSkill) =>
    `Refusing to relocate modified Skill from ${projection.path}`;
  // Refuse an edited former copy before creating another installation or removing any old copy.
  for (const projection of former) {
    if ((yield* inspectInstalledSkill(projection)).kind === "conflicted")
      return yield* new InstalledSkillRetireConflict({ detail: retirementMessage(projection) });
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
        for (const existing of mutation.state.projections.filter(
          (item) => atTarget(item) && !boundSkillIds.includes(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === existing.skill_id);
          if (skill === undefined) continue;
          // A copy without SKIT's marker was never SKIT's to remove: it was already there when SKIT
          // tried to install (a conflict). Disabling drops SKIT's record and leaves it in place. A
          // managed copy edited since SKIT wrote it is refused, so no edit is lost.
          const marker = yield* inspectOwnershipMarker(existing.path);
          yield* mutation.retire(
            existing,
            marker.kind === "absent" ? "report" : "throw",
            `Refusing to disable ${skill.name}: ${existing.path} was edited after SKIT wrote it`,
          );
        }
        mutation.state.projections.splice(
          0,
          mutation.state.projections.length,
          ...mutation.state.projections.filter((item) => !atTarget(item)),
        );
        const toRetire: InstalledSkill[] = [];
        for (const item of selected) {
          const source = yield* installedSkillSource(
            mutation.state,
            store.originalsPath,
            item.skill,
            item.version,
          );
          if (source.kind === "invalid")
            return yield* new InstalledSkillInvalid({ detail: source.detail });
          const previousRows = state.projections.filter(
            (candidate) => candidate.skill_id === item.skill.skill_id && atTarget(candidate),
          );
          const priorProjection = previousRows[0];
          const projectionId = priorProjection?.projection_id ?? makeInstalledSkillId();
          const policy = binding.invocation_policies?.[item.skill.skill_id];
          const projected = yield* mutation.project({
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
            ...(priorProjection === undefined ? {} : { previous: priorProjection }),
            identity: {
              projectionId,
              skillId: item.skill.skill_id,
              skillVersionId: item.version.skill_version_id,
            },
            ...(options.acceptedObservations?.get(projectionId) === undefined
              ? {}
              : {
                  replacement: {
                    projectionId,
                    ...options.acceptedObservations.get(projectionId)!,
                  },
                }),
            ...(options.manage === undefined ? {} : { manage: options.manage }),
            ...(options.manageIdentical ? { manageIdentical: true } : {}),
            restoreNativeDeletion:
              options.restoreNativeDeletedSkills?.includes(item.skill.skill_id) ?? false,
            projectedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          });
          mutation.state.projections.push(projected);
          // Keep the last working copy when the new destination is blocked or locally modified.
          if (projected.status === "installed")
            toRetire.push(
              ...former.filter((candidate) => candidate.skill_id === item.skill.skill_id),
            );
        }
        // Finish the whole installation batch before removing any former working copy.
        for (const old of toRetire) {
          if ((yield* inspectInstalledSkill(old)).kind === "conflicted")
            return yield* new InstalledSkillRetireConflict({ detail: retirementMessage(old) });
        }
        for (const old of toRetire) {
          yield* mutation.retire(old, "throw", retirementMessage(old));
          const index = mutation.state.projections.findIndex(
            (candidate) => candidate.projection_id === old.projection_id,
          );
          if (index >= 0) mutation.state.projections.splice(index, 1);
        }
        return selected.length;
      }),
  );
  return result.projected;
});
