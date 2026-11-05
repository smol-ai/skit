import { SkitConfiguration } from "@smolai/skit-core";
import { Effect } from "effect";
import { inspectLibrarySource } from "../application/import-source.js";
import { openLibraryView } from "@smolai/skit-core/library/session";

export const checkSubjects = Effect.fn("CLI.checkSubjects")(function* (
  query?: string,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
  const view = yield* Effect.flatMap(SkitConfiguration, (paths) => openLibraryView(paths.skitHome));
  return yield* view.checkSubjects(query, { inspectSource: inspectLibrarySource, onCollection });
});
