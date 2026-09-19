import { LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import {
  addLibrarySourceEffect,
  acquisitionSourceEffect,
  inspectLibrarySourceEffect,
  type AddOptions,
} from "./add.js";
import type { UpdateResult } from "./update-contract.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { Renderer } from "../../presentation/renderer.js";

export class UpdateNotFound extends Schema.TaggedError<UpdateNotFound>()("Library.UpdateNotFound", {
  query: Schema.String,
}) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Collection.";
}
export class UpdateAmbiguous extends Schema.TaggedError<UpdateAmbiguous>()(
  "Library.UpdateAmbiguous",
  { query: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Collection ID to select one Collection.";
}
export class UpdateNoSource extends Schema.TaggedError<UpdateNoSource>()("Library.UpdateNoSource", {
  collection_id: Schema.String,
}) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "This Collection has no Acquisition source to validate for update.";
}

export interface UpdateOptions extends AddOptions {
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const collectionAcquisition = (
  state: LibraryState,
  collection: LibraryState["collections"][number],
) => {
  if (collection.upstream?.last_acquisition_id !== undefined)
    return state.acquisitions.find(
      (acquisition) => acquisition.acquisition_id === collection.upstream?.last_acquisition_id,
    );
  const acquisitionIds = new Set(
    state.skills
      .filter((skill) => skill.collection_id === collection.collection_id)
      .flatMap((skill) =>
        skill.versions.flatMap((version) => version.origins.map((origin) => origin.acquisition_id)),
      ),
  );
  return [...state.acquisitions]
    .filter((acquisition) => acquisitionIds.has(acquisition.acquisition_id))
    .sort((a, b) => b.acquired_at.localeCompare(a.acquired_at))[0];
};

const selectCollections = Effect.fn("Library.selectUpdates")(function* (
  state: LibraryState,
  query?: string,
) {
  if (query === undefined)
    return state.collections.filter(
      (collection) => collectionAcquisition(state, collection) !== undefined,
    );
  const matches = state.collections.filter(
    (collection) =>
      [collection.collection_id, collection.label].includes(query) ||
      state.skills.some(
        (skill) =>
          skill.collection_id === collection.collection_id &&
          (skill.name === query || skill.skill_id === query),
      ),
  );
  if (matches.length === 0) return yield* new UpdateNotFound({ query });
  if (matches.length !== 1) return yield* new UpdateAmbiguous({ query });
  return matches;
});

export const planUpdatesEffect = Effect.fn("Library.planUpdates")(function* (
  state: LibraryState,
  options: UpdateOptions,
  query?: string,
) {
  const selected = yield* selectCollections(state, query);
  return yield* Effect.forEach(selected, (collection) =>
    Effect.gen(function* () {
      const acquisition = collectionAcquisition(state, collection);
      if (acquisition === undefined)
        return yield* new UpdateNoSource({ collection_id: collection.collection_id });
      const tree = state.retained_copies.find(
        (candidate) => candidate.retained_copy_id === acquisition.retained_copy_id,
      );
      if (tree === undefined) return yield* new UpdateNotFound({ query: collection.collection_id });
      const inspected = yield* inspectLibrarySourceEffect(
        options,
        yield* acquisitionSourceEffect(acquisition),
      );
      return {
        collection_id: collection.collection_id,
        current_snapshot_digest: tree.digest,
        available_snapshot_digest: inspected.snapshot_digest,
        changed: tree.digest !== inspected.snapshot_digest,
      };
    }),
  );
});

export const updateCollectionsEffect = Effect.fn("Library.updateCollections")(function* (
  state: LibraryState,
  options: UpdateOptions,
  query?: string,
) {
  const selected = yield* selectCollections(state, query);
  const renderer = yield* Renderer;
  const results: UpdateResult[number][] = [];
  for (const before of selected) {
    const acquisition = collectionAcquisition(state, before);
    if (acquisition === undefined)
      return yield* new UpdateNoSource({ collection_id: before.collection_id });
    const priorTree = state.retained_copies.find(
      (tree) => tree.retained_copy_id === acquisition.retained_copy_id,
    );
    if (priorTree === undefined) return yield* new UpdateNotFound({ query: before.collection_id });
    const retained = yield* renderer.withStatus(
      {
        pending: `${before.label} · Fetching and inspecting Source`,
        complete: (value) =>
          value.snapshot_digest === priorTree.digest
            ? `${before.label} · Source is current`
            : `${before.label} · New snapshot retained`,
      },
      addLibrarySourceEffect(options, yield* acquisitionSourceEffect(acquisition)),
    );
    const changed = retained.snapshot_digest !== priorTree.digest;
    let projected = 0;
    let deferred = 0;
    if (changed) {
      const current = yield* (yield* LibraryStore).load;
      const reconciled = yield* renderer.withStatus(
        {
          pending: `${before.label} · Updating projected Skills`,
          complete: (value) =>
            value.projected
              ? `${before.label} · ${value.projected} projected Skill${value.projected === 1 ? "" : "s"} updated`
              : value.deferred
                ? `${before.label} · ${value.deferred} projected Skill${value.deferred === 1 ? "" : "s"} deferred`
                : `${before.label} · No projected Skills needed updating`,
        },
        reconcileLibraryProjections({
          roots: options.roots,
          variantsPath: options.variantsPath,
          onlyBindings: [...current.global_bindings, ...current.local_bindings].filter((binding) =>
            binding.skills.some((skillId) =>
              state.skills.some(
                (skill) =>
                  skill.skill_id === skillId && skill.collection_id === before.collection_id,
              ),
            ),
          ),
        }),
      );
      projected = reconciled.projected;
      deferred = reconciled.deferred;
    }
    results.push({
      collection_id: before.collection_id,
      previous_retained_copy_id: priorTree.retained_copy_id,
      selected_retained_copy_id: retained.retained_version_id,
      snapshot_digest: retained.snapshot_digest,
      changed,
      projected,
      deferred,
    });
  }
  return results;
});
