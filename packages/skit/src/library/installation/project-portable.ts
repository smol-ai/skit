import { Clock, Effect, Schema } from "effect";
import { join, resolve } from "node:path";
import { validateSkitDirectoryEffect } from "../../artifact/skit.js";
import type { OwnershipMarker } from "../../contracts.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../../projection/policy.js";
import { withProjectionMutationEffect } from "../../projection/mutation.js";
import { originalTreeHashEffect, retainedTreePath } from "../retention/retain-tree.js";
import { LibraryStore } from "../store/library-store.js";
import type { Digest, HarnessName } from "../store/state-schema.js";
import type { ManagedProjection } from "../portable-local-state.js";
import { makeProjectionId } from "../entity-ids.js";

export class PortableProjectionInvalid extends Schema.TaggedError<PortableProjectionInvalid>()(
  "Library.PortableProjectionInvalid",
  { detail: Schema.String },
) {}

/** Reconcile one Binding against one available Harness root. Caller owns the writer lock. */
export const projectPortableBindingEffect = Effect.fn("Library.projectPortableBinding")(
  function* (options: {
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
    if (binding === undefined)
      return yield* new PortableProjectionInvalid({ detail: "Binding is missing" });

    const selected = state.skills
      .filter((candidate) => binding.skills.includes(candidate.skill_id))
      .flatMap((skill) => {
        const version = skill?.versions.find(
          (candidate) => candidate.skill_version_id === skill.selected_skill_version_id,
        );
        if (
          skill === undefined ||
          version === undefined ||
          !binding.skills.includes(skill.skill_id)
        )
          return [];
        const origin = version.origins[0];
        const acquisition = state.acquisitions.find(
          (candidate) => candidate.acquisition_id === origin?.acquisition_id,
        );
        const tree = state.retained_copies.find(
          (candidate) => candidate.retained_copy_id === acquisition?.retained_copy_id,
        );
        const member = tree?.members.find(
          (candidate) => candidate.source_path === origin?.source_path,
        );
        return tree === undefined || member === undefined ? [] : [{ skill, version, tree, member }];
      });
    if (selected.length !== binding.skills.length)
      return yield* new PortableProjectionInvalid({
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
            (item) => atTarget(item) && !binding.skills.includes(item.skill_id),
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
              return yield* new PortableProjectionInvalid({
                detail: "retained authored descriptor is invalid",
              });
            const descriptorSkill = validated?.descriptor.skills.find(
              (candidate) => candidate.name === item.skill.name,
            );
            if (authored && descriptorSkill === undefined)
              return yield* new PortableProjectionInvalid({
                detail: `authored descriptor lacks ${item.skill.name}`,
              });
            const retainedPath =
              item.member.source_path === "." ? root : join(root, item.member.source_path);
            if ((yield* originalTreeHashEffect(retainedPath)) !== item.version.source_digest)
              return yield* new PortableProjectionInvalid({
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
  },
);
