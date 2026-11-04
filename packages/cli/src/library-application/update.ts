import { Library, SkitConfiguration } from "@smolai/skit-core";
import { updateSources } from "@smolai/skit-core/library/session";
import { Effect } from "effect";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import type { UpdateResult } from "../workflows/library/update-contract.js";
import { importSource, inspectLibrarySource } from "./import-source.js";
import { openLibraryView } from "./library-view.js";
import { LibraryProgress } from "./progress.js";
import { commandFailure } from "../failure-classification.js";
export { CollectionNotUpdatable } from "@smolai/skit-core/library/session";
export interface UpdateOptions {
  readonly roots: InventoryRootOptions;
}

export const planUpdates = Effect.fn("CLI.planUpdates")(function* (query?: string) {
  const view = yield* openLibraryView();
  return yield* view.previewSourceUpdates(query, inspectLibrarySource);
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

export const updateSubjects = Effect.fn("CLI.updateSubjects")(function* (
  options: UpdateOptions,
  query?: string,
) {
  const paths = yield* SkitConfiguration;
  const progress = yield* LibraryProgress;
  return yield* updateSources(paths.skitHome, options.roots, query, {
    progress,
    classifyFailure: commandFailure,
    importSource: (input, previous, owner) =>
      importSource(input, previous).pipe(Effect.provideService(Library.Service, owner)),
  });
});
