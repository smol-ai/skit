import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { inspectLibrarySource } from "../source.js";
import { checkLibrarySubjects } from "@smolai/skit-core/library/session";

export const checkSubjects = Effect.fn("CLI.checkSubjects")(function* (
  query?: string,
  onCollection?: (collection: {
    readonly collection_id: string;
    readonly display_name: string;
  }) => Effect.Effect<void>,
) {
  return yield* checkLibrarySubjects((yield* SkitConfiguration).skitHome, query, {
    inspectSource: inspectLibrarySource,
    onCollection,
  });
});
