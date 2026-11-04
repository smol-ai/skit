import { Brand } from "effect";
import { libraryStateRevision, type LibraryState } from "./library-state.js";
import type { InspectedLibraryState } from "./store/state-file.js";

/** What one read saw. "Absent" has its own revision, so a first sync can plan from it. */
export type Snapshot =
  | { readonly _tag: "Absent"; readonly revision: Revision }
  | { readonly _tag: "Present"; readonly revision: Revision; readonly state: LibraryState };
/**
 * Covers presence and the whole decoded state, so any unfinished operation state.json records. A
 * Present revision is the state's canonical digest, the one a plan carries as its baseRevision;
 * "absent" is never such a digest.
 */
export type Revision = Brand.Branded<string, "Revision">;
export const Revision = Brand.nominal<Revision>();

export const snapshotOf = (inspected: InspectedLibraryState): Snapshot =>
  inspected.present
    ? {
        _tag: "Present",
        revision: Revision(libraryStateRevision(inspected.state)),
        state: inspected.state,
      }
    : { _tag: "Absent", revision: Revision("absent") };
