import type { InspectedLibraryState } from "./store/library-store.js";
import { Schema } from "effect";
import { libraryStateRevision, type LibraryState } from "./library-state.js";

/** What one read saw. "Absent" has its own revision, so a first sync can plan from it. */
export type Snapshot =
  | { readonly _tag: "Absent"; readonly revision: Revision }
  | { readonly _tag: "Present"; readonly revision: Revision; readonly state: LibraryState };
/**
 * Persisted snapshots carry the database transaction counter as well as a content hash. The
 * counter rejects an edit followed by its inverse; the hash detects a caller changing the supplied
 * state. Prospective states have only a content hash and cannot apply as a persisted snapshot.
 * An empty Library and an absent Library must never share a revision.
 */
export const Revision = Schema.String.pipe(Schema.brand("Revision"));
export type Revision = typeof Revision.Type;

export const snapshotOf = (
  inspected:
    | InspectedLibraryState
    | { readonly present: true; readonly state: LibraryState; readonly revision?: number },
): Snapshot =>
  inspected.present
    ? {
        _tag: "Present",
        revision: Revision.make(
          `present:${inspected.revision === undefined ? "" : `${inspected.revision}:`}${libraryStateRevision(inspected.state)}`,
        ),
        state: inspected.state,
      }
    : { _tag: "Absent", revision: Revision.make("absent") };

/** Content-only prospective snapshots have no database transaction to compare. */
export const snapshotDatabaseRevision = (revision: Revision): number | undefined => {
  const match = /^present:(0|[1-9][0-9]*):[a-f0-9]{64}$/.exec(revision);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
};
