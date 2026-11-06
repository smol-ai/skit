import { SkitConfiguration } from "@smolai/skit-core/platform";
import { updateSources, previewLibrarySourceUpdates } from "@smolai/skit-core/library/update";
import { Effect } from "effect";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import type { UpdateResult } from "./output.js";
import { importSource, inspectLibrarySource } from "../source.js";

import { LibraryProgress } from "./progress.js";
import { commandFailure } from "../../commands/failure-classification.js";
export interface UpdateOptions {
  readonly roots: InventoryRootOptions;
}

export const planUpdates = Effect.fn("CLI.planUpdates")(function* (query?: string) {
  return yield* previewLibrarySourceUpdates(
    (yield* SkitConfiguration).skitHome,
    query,
    inspectLibrarySource,
  );
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
    importSource,
  });
});
