import { Effect } from "effect";
import { importSource, type SkitSource } from "@smolai/skit-core/library/source";
import type { Interface } from "@smolai/skit-core/library";
import { sourceRequest } from "../../registry/library-source.js";
import { LibraryProgress } from "./progress.js";
import { commandFailure } from "../../commands/failure-classification.js";

/** What the CLI lends a source update: its progress, its failure codes and its Registry sources. */
export const updateAdapters = Effect.map(LibraryProgress, (progress) => ({
  progress,
  classifyFailure: commandFailure,
  importSource: Effect.fn("CLI.update.importSource")(function* (
    source: SkitSource,
    previousSkillPaths: readonly string[],
    imports: Interface["import"],
  ) {
    return yield* importSource(imports, yield* sourceRequest(source, previousSkillPaths));
  }),
}));
