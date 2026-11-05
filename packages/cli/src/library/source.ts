import { officialRegistryOrigin } from "../registry/accounts.js";
import {
  inspectSource,
  importSource as importLibrarySource,
  parseSkitSource,
  sourceLocator,
  type SkitSource,
} from "@smolai/skit-core/library/source";
import { Effect, Result } from "effect";
import { Registry, type ResolvedAuth } from "../registry/index.js";

/** Registry credential selection stays with the frontend; Library owns acquired source bytes. */
const sourceRequest = Effect.fn("CLI.sourceRequest")(function* (
  input: string | SkitSource,
  previousSkillPaths: readonly string[] | undefined,
  selectedRegistry?: ResolvedAuth,
) {
  const authState =
    selectedRegistry === undefined
      ? yield* Registry.credentials().pipe(Effect.result)
      : Result.succeed(selectedRegistry);
  const resolvedRegistry = Result.isSuccess(authState) ? authState.success : undefined;
  const source = typeof input === "string" ? yield* parseSkitSource(input) : input;
  const registry: ResolvedAuth | undefined =
    resolvedRegistry?.origin === undefined && source.type === "registry"
      ? { origin: officialRegistryOrigin, source: "none" }
      : resolvedRegistry;
  if (source.type === "registry" && Result.isFailure(authState))
    return yield* Effect.fail(authState.failure);
  return {
    source,
    input: typeof input === "string" ? input : sourceLocator(input),
    registryBaseUrl: registry?.origin,
    registryToken: registry?.token,
    ...(previousSkillPaths === undefined ? {} : { previousSkillPaths }),
  };
});

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
