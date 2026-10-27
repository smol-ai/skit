import { LibraryStore, withLibraryWriter, type LibraryState } from "@smolai/skit-core";
import { Effect } from "effect";
import type { InventoryRootOptions } from "../projection/roots.js";
import type { UpdateResult } from "../workflows/library/update-contract.js";
import {
  latestSourceImport,
  resolveOwningLibrarySubjects,
} from "../workflows/library/subject-resolution.js";
import { previewCollectionUpdate, updateCollection } from "./collection-update.js";
export { CollectionNotUpdatable } from "./collection-update.js";

export interface UpdateOptions {
  readonly roots: InventoryRootOptions;
}

const selectSubjects = Effect.fn("Library.selectUpdates")(function* (
  state: LibraryState,
  query?: string,
) {
  const matches = yield* resolveOwningLibrarySubjects(state, query);
  if (query === undefined)
    return matches.filter(
      (subject) =>
        latestSourceImport(state, subject) !== undefined &&
        subject.kind === "collection" &&
        subject.collection.upstream !== undefined,
    );
  return matches;
});

/** Preview the Collections selected from the current Library. */
export const planUpdates = Effect.fn("Library.planUpdates")(function* (query?: string) {
  const state = yield* (yield* LibraryStore).load;
  const selected = yield* selectSubjects(state, query);
  return yield* Effect.forEach(selected, (subject) => previewCollectionUpdate(state, subject));
});

/** Preserve a uniform failure code; mixed success or failure types use the batch code. */
export function updateExitCode(outcomes: UpdateResult): number {
  const failures = outcomes.filter((item) => "status" in item);
  if (failures.length === 0) return 0;
  const code = failures[0]!.error.exitCode;
  return failures.length === outcomes.length &&
    failures.every((item) => item.error.exitCode === code)
    ? code
    : 1;
}

/** Keep selection, baseline and ordered results inside one batch writer. */
export const updateSubjects = Effect.fn("Library.updateSubjects")(function* (
  options: UpdateOptions,
  query?: string,
) {
  const state = yield* (yield* LibraryStore).load;
  const selected = yield* selectSubjects(state, query);
  return yield* Effect.forEach(selected, (subject) => updateCollection(state, subject, options));
}, withLibraryWriter);
