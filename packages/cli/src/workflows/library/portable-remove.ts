import { removePortableCollectionEffect, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";

export class PortableRemoveNotFound extends Schema.TaggedError<PortableRemoveNotFound>()(
  "Library.PortableRemoveNotFound",
  { query: Schema.String },
) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Collection.";
}
export class PortableRemoveAmbiguous extends Schema.TaggedError<PortableRemoveAmbiguous>()(
  "Library.PortableRemoveAmbiguous",
  { query: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Collection ID to name exactly one Collection.";
}

export interface PortableRemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
  readonly variantsPath: string;
}

export const planPortableRemoveEffect = Effect.fn("Library.planPortableRemove")(function* (
  state: LibraryState,
  query: string,
) {
  const matches = state.collections.filter(
    (collection) =>
      [collection.collection_id, collection.display_name].includes(query) ||
      state.skills.some(
        (skill) =>
          skill.collection_id === collection.collection_id &&
          (skill.name === query ||
            skill.skill_id === query ||
            skill.versions.some((version) => version.skill_version_id === query)),
      ),
  );
  if (matches.length === 0) return yield* new PortableRemoveNotFound({ query });
  if (matches.length !== 1) return yield* new PortableRemoveAmbiguous({ query });
  const collection = matches[0];
  if (collection === undefined) return yield* new PortableRemoveNotFound({ query });
  const skills = state.skills.filter((skill) => skill.collection_id === collection.collection_id);
  return {
    collection_id: collection.collection_id,
    versions: skills.reduce((count, skill) => count + skill.versions.length, 0),
    skills: skills.length,
    global_bindings: state.global_bindings.filter(
      (binding) => binding.collection_id === collection.collection_id,
    ).length,
    repository_bindings: state.local_bindings.filter(
      (binding) => binding.collection_id === collection.collection_id,
    ).length,
    owned_projections: state.projections.filter(
      (projection) => projection.collection_id === collection.collection_id,
    ).length,
  };
});

export const executePortableRemoveEffect = Effect.fn("Library.executePortableRemove")(function* (
  state: LibraryState,
  options: PortableRemoveOptions,
) {
  const plan = yield* planPortableRemoveEffect(state, options.query);
  if (options.dryRun) return { kind: "plan" as const, value: plan };
  const removed = yield* removePortableCollectionEffect({
    collectionId: plan.collection_id,
    variantsPath: options.variantsPath,
  });
  return { kind: "removed" as const, value: { ...plan, retired: removed.retired } };
});
