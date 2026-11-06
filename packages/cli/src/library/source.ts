import {
  inspectSource,
  importSource as importLibrarySource,
  type SkitSource,
} from "@smolai/skit-core/library/source";
import { Effect } from "effect";
import type { ResolvedAuth } from "../registry/index.js";
import { sourceRequest } from "../registry/library-source.js";

export const inspectLibrarySource = Effect.fn("CLI.inspectSource")(function* (
  input: string | SkitSource,
  previousSkillPaths?: readonly string[],
  registry?: ResolvedAuth,
) {
  return yield* inspectSource(yield* sourceRequest(input, previousSkillPaths, registry));
});

export const previewLibrarySource = Effect.fn("Library.previewSource")(function* (
  input: string | SkitSource,
  registry?: ResolvedAuth,
) {
  const inspected = yield* inspectLibrarySource(input, undefined, registry);
  return {
    kind: inspected.kind,
    skills: inspected.skills,
    ...("diagnostics" in inspected ? { diagnostics: inspected.diagnostics } : {}),
  };
});

/** Library keeps staging alive until retention finishes. */
export const importSource = Effect.fn("CLI.importSource")(function* (
  input: string | SkitSource,
  previousSkillPaths?: readonly string[],
  registry?: ResolvedAuth,
) {
  return yield* importLibrarySource(yield* sourceRequest(input, previousSkillPaths, registry));
});
