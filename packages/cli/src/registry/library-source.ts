import { officialRegistryOrigin } from "./accounts.js";
import { parseSkitSource, sourceLocator, type SkitSource } from "@smolai/skit-core/library/source";
import { Effect, Result } from "effect";
import { Registry, type ResolvedAuth } from "./index.js";

/** Registry owns credential selection; Library owns acquired source bytes. */
export const sourceRequest = Effect.fn("CLI.sourceRequest")(function* (
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
