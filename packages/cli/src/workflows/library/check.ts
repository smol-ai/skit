import { Effect } from "effect";
import { inspectLibrarySource } from "../../library-application/import-source.js";
import { openLibraryView } from "../../library-application/library-view.js";

export const checkSubjects = Effect.fn("CLI.checkSubjects")(function* (
  query?: string,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
  const view = yield* openLibraryView();
  return yield* view.checkSubjects(query, { inspectSource: inspectLibrarySource, onCollection });
});
