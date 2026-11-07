import type { InspectedLibraryState } from "./store/library-store.js";
import { Schema } from "effect";
import { libraryStateRevision, type LibraryState } from "./library-state.js";

/** What one read saw. "Absent" has its own revision, so a first sync can plan from it. */
export type Snapshot =
  | { readonly _tag: "Absent"; readonly revision: Revision }
  | { readonly _tag: "Present"; readonly revision: Revision; readonly state: LibraryState };
/**
 * Covers presence and the whole decoded state, so any unfinished operation state.json records. A
 * Present revisions include the state's canonical hash and its presence. An empty state.json
 * and no state.json must never share a revision.
 */
export const Revision = Schema.String.pipe(Schema.brand("Revision"));
export type Revision = typeof Revision.Type;

export const snapshotOf = (inspected: InspectedLibraryState): Snapshot =>
  inspected.present
    ? {
        _tag: "Present",
        revision: Revision.make(`present:${libraryStateRevision(inspected.state)}`),
        state: inspected.state,
      }
    : { _tag: "Absent", revision: Revision.make("absent") };
