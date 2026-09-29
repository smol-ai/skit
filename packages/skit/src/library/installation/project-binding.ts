import { Clock, Effect, Schema } from "effect";
import { join, resolve } from "node:path";
import { validateSkitDirectoryEffect } from "../../artifact/skit.js";
import type { OwnershipMarker } from "../../contracts.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../../projection/policy.js";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { originalTreeHashEffect, retainedTreePath } from "../retention/retain-tree.js";
import { LibraryStore } from "../store/library-store.js";
import type { Digest, HarnessName } from "../store/state-schema.js";
import type { ManagedProjection } from "../library-state.js";
import { makeProjectionId } from "../entity-ids.js";
import { bindingSkillIds, currentSkillVersion, versionBacking } from "../library-contracts.js";

export class ProjectionInvalid extends Schema.TaggedError<ProjectionInvalid>()(
  "Library.ProjectionInvalid",
  { detail: Schema.String },
) {}

/** Reconcile one Binding against one available Harness root. Caller owns the writer lock. */
export const projectBindingEffect = Effect.fn("Library.projectBinding")(function* (options: {
  harness: HarnessName;
  scope?: { kind: "global" } | { kind: "repository"; root: string };
  root: string;
  variantsPath: string;
  acceptedObservations?: ReadonlyMap<
    string,
    { readonly observedHash: Digest; readonly marker: OwnershipMarker }
  >;
  adoptionObservedHash?: Digest;
}) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const scope = options.scope ?? { kind: "global" as const };
  const binding =
    scope.kind === "global"
      ? state.global_bindings.find((item) => item.harness === options.harness)
      : state.local_bindings.find(
          (item) =>
            item.harness === options.harness && resolve(item.scope.root) === resolve(scope.root),
        );
  if (binding === undefined) return yield* new ProjectionInvalid({ detail: "Binding is missing" });

  const boundSkillIds = bindingSkillIds(state, binding);
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

  const atTarget = (projection: ManagedProjection) =>
    projection.harness === options.harness && resolve(projection.root) === resolve(options.root);
  const result = yield* withProjectionMutationEffect(
    state,
    {
      rootFor: () => options.root,
      variantsPath: options.variantsPath,
      publish: store.publish,
    },
    (mutation) =>
      Effect.gen(function* () {
        for (const existing of mutation.state.projections.filter(
          (item) => atTarget(item) && !boundSkillIds.includes(item.skill_id),
        )) {
          const skill = mutation.state.skills.find((item) => item.skill_id === existing.skill_id);
          if (skill === undefined) continue;
          const retired = yield* mutation.retire(
            existing,
            "throw",
            `Refusing to disable modified ${skill.name} on ${options.harness}`,
          );
          void retired;
        }
        mutation.state.projections.splice(
          0,
          mutation.state.projections.length,
          ...mutation.state.projections.filter((item) => !atTarget(item)),
        );
        for (const item of selected) {
          const root = retainedTreePath(store.originalsPath, item.tree.digest);
          const authored = item.version.materialization_profile === "declared-skit-skill/v1";
          const validated = authored
            ? yield* validateSkitDirectoryEffect(root, "retained", {
                assessmentContext: "project",
                acceptances: mutation.state.assessmentAcceptances ?? [],
                evaluatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
              })
            : undefined;
          if (validated?.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
            return yield* new ProjectionInvalid({
              detail: "retained authored descriptor is invalid",
            });
          const descriptorSkill = validated?.descriptor.skills.find(
            (candidate) => candidate.name === item.skill.name,
          );
          if (authored && descriptorSkill === undefined)
            return yield* new ProjectionInvalid({
              detail: `authored descriptor lacks ${item.skill.name}`,
            });
          const retainedPath =
            item.member.source_path === "." ? root : join(root, item.member.source_path);
          if ((yield* originalTreeHashEffect(retainedPath)) !== item.version.source_digest)
            return yield* new ProjectionInvalid({
              detail: `retained Skill ${item.skill.name} changed`,
            });
          const previousRows = state.projections.filter(
            (candidate) => candidate.skill_id === item.skill.skill_id && atTarget(candidate),
          );
          const priorProjection = previousRows[0];
          const projectionId = priorProjection?.projection_id ?? makeProjectionId();
          const policy = binding.invocation_policies?.[item.skill.skill_id];
          const projectionPath = resolve(join(options.root, item.skill.name));
          const projected = yield* mutation.project({
            installation: { libraryPath: root },
            skill: {
              skillId: item.skill.skill_id,
              skillVersionId: item.version.skill_version_id,
              name: item.skill.name,
              contentHash: item.version.validation_identity_digest,
            },
            harness: options.harness,
            root: options.root,
            sourcePath:
              descriptorSkill === undefined ? retainedPath : join(root, descriptorSkill.path),
            ...(descriptorSkill === undefined
              ? {}
              : {
                  shared: descriptorSkill.shared,
                  declaredInvocation: descriptorSkill.invocation,
                }),
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
            ...(options.adoptionObservedHash === undefined
              ? {}
              : {
                  adoption: {
                    path: projectionPath,
                    observedHash: options.adoptionObservedHash,
                  },
                }),
            projectedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          });
          mutation.state.projections.push(projected);
        }
        return selected.length;
      }),
  );
  return result.value;
});
