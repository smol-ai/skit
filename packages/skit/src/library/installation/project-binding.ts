import { Data, Clock, Effect } from "effect";
import { resolve } from "node:path";
import type { OwnershipMarker } from "../../contracts.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../../projection/policy.js";
import {
  projectionCustodyEffect,
  withProjectionMutationEffect,
} from "../../projection/mutation.js";
import { pathIsWithin, projectionTargetPathIdentityEffect } from "../../platform/path-identity.js";
import { ProjectionRetireConflict } from "../../failures.js";
import { repositorySelectsProjection } from "./retire-unbound.js";
import { projectionSourceEffect } from "./projection-source.js";
import { LibraryStore } from "../store/library-store.js";
import type { Digest, ProjectionTarget } from "../../vocabulary.js";
import { scopeBinding, type ManagedProjection } from "../library-state.js";
import { makeProjectionId } from "../entity-ids.js";
import { bindingSkillIds, currentSkillVersion, versionBacking } from "../library-contracts.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class ProjectionInvalid
  extends Data.TaggedError("Library.ProjectionInvalid")<{
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
export const projectBindingEffect = Effect.fn("Library.projectBinding")(function* (options: {
  target: ProjectionTarget;
  scope?: { kind: "global" } | { kind: "repository"; root: string };
  root: string;
  variantsPath: string;
  acceptedObservations?: ReadonlyMap<
    string,
    {
      readonly observedHash: Digest;
      readonly marker: OwnershipMarker;
      readonly allowDifferent?: boolean;
    }
  >;
  /** Reconcile just this existing Projection, without changing other copies in the Binding. */
  onlyProjection?: { readonly projectionId: string; readonly skillId: string };
  /** The one existing copy the operator chose to take custody of, as previewed. */
  adoption?: { readonly path: string; readonly observedHash: Digest };
  restoreNativeDeletedSkills?: readonly string[];
}) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const scope = options.scope ?? { kind: "global" as const };
  const binding = scopeBinding(state, scope);
  if (binding === undefined) return yield* new ProjectionInvalid({ detail: "Binding is missing" });

  const allBoundSkillIds = bindingSkillIds(state, binding);
  const boundSkillIds = options.onlyProjection
    ? allBoundSkillIds.filter((id) => id === options.onlyProjection!.skillId)
    : allBoundSkillIds;
  if (options.onlyProjection && boundSkillIds.length !== 1)
    return yield* new ProjectionInvalid({
      detail: "The selected copy is not enabled in this Binding",
    });
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
    return yield* new ProjectionInvalid({
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
    const identity = yield* projectionTargetPathIdentityEffect(root).pipe(
      Effect.orElseSucceed(() => ({
        comparisonKey: `path:${resolve(root)}`,
        canonicalPath: resolve(root),
      })),
    );
    rootKeys.set(root, identity.comparisonKey);
    canonicalRoots.set(root, identity.canonicalPath ?? resolve(root));
  }
  const atTarget = (projection: ManagedProjection) =>
    projection.target === options.target &&
    rootKeys.get(projection.root) === rootKeys.get(options.root);
  if (
    options.onlyProjection &&
    !state.projections.some(
      (projection) =>
        projection.projection_id === options.onlyProjection!.projectionId &&
        projection.skill_id === options.onlyProjection!.skillId &&
        atTarget(projection),
    )
  )
    return yield* new ProjectionInvalid({
      detail: "The selected copy is no longer at this destination",
    });
  const former =
    scope.kind === "global" && !options.onlyProjection
      ? state.projections.filter(
          (projection) =>
            projection.target === options.target &&
            !atTarget(projection) &&
            boundSkillIds.includes(projection.skill_id) &&
            !repositorySelectsProjection(state, projection) &&
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
  const retirementMessage = (projection: ManagedProjection) =>
    `Refusing to relocate modified Skill from ${projection.path}`;
  // Refuse an edited former copy before creating another installation or removing any old copy.
  for (const projection of former) {
    if ((yield* projectionCustodyEffect(projection)).kind === "conflicted")
      return yield* new ProjectionRetireConflict({ detail: retirementMessage(projection) });
  }
  const result = yield* withProjectionMutationEffect(
    state,
    {
      rootFor: () => options.root,
      variantsPath: options.variantsPath,
      originalsPath: store.originalsPath,
      publish: store.publish,
    },
    (mutation) =>
      Effect.gen(function* () {
        for (const existing of mutation.state.projections.filter(
          (item) =>
            !options.onlyProjection && atTarget(item) && !boundSkillIds.includes(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === existing.skill_id);
          if (skill === undefined) continue;
          const retired = yield* mutation.retire(
            existing,
            "throw",
            `Refusing to disable modified ${skill.name} at ${existing.path}`,
          );
          void retired;
        }
        mutation.state.projections.splice(
          0,
          mutation.state.projections.length,
          ...mutation.state.projections.filter(
            (item) =>
              !atTarget(item) ||
              (options.onlyProjection !== undefined &&
                item.projection_id !== options.onlyProjection.projectionId),
          ),
        );
        const toRetire: ManagedProjection[] = [];
        for (const item of selected) {
          const source = yield* projectionSourceEffect(
            mutation.state,
            store.originalsPath,
            item.skill,
            item.version,
          );
          if (source.kind === "invalid")
            return yield* new ProjectionInvalid({ detail: source.detail });
          const previousRows = state.projections.filter(
            (candidate) =>
              candidate.skill_id === item.skill.skill_id &&
              atTarget(candidate) &&
              (options.onlyProjection === undefined ||
                candidate.projection_id === options.onlyProjection.projectionId),
          );
          const priorProjection = previousRows[0];
          const projectionId = priorProjection?.projection_id ?? makeProjectionId();
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
            ...(options.adoption === undefined ? {} : { adoption: options.adoption }),
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
          if ((yield* projectionCustodyEffect(old)).kind === "conflicted")
            return yield* new ProjectionRetireConflict({ detail: retirementMessage(old) });
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
