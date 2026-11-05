import { Context } from "effect";

/**
 * Who is mutating the Library, for its history. A front end provides it once at its composition
 * root; it is a diagnostic label and not an authority, so an unlabelled mutation is still recorded.
 */
export const LibraryActor = Context.Reference<string>("skit/library/LibraryActor", {
  defaultValue: () => "unattributed",
});
