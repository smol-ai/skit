import { Library } from "@smolai/skit-core/library";
import { officialRegistryOrigin } from "../../registry/accounts.js";
import {
  describeSourceSkills,
  inspectResolvedSource,
  leaveResolvedPnpmSkills,
  parseSkitSource,
  sourceLocator,
  resolveSkitSource,
  type ResolvedSkitSource,
  type SkitSource,
  leavePnpmSkill,
} from "@smolai/skit-core";
import { Clock, Effect, Result } from "effect";
import { Registry, type ResolvedAuth } from "../../registry/index.js";

export { AddNoSkills } from "@smolai/skit-core";

/** Resolve once inside the lifetime of the operation consuming the staged source. */
const withResolvedSource = Effect.fn("SourceAcquisition.withResolvedSource")(function* <A, E, R>(
  input: string | SkitSource,
  previousSkillPaths: readonly string[] | undefined,
  use: (prepared: {
    parsed: SkitSource;
    resolved: ResolvedSkitSource;
    historicalInput: string;
    registryOrigin: string | undefined;
  }) => Effect.Effect<A, E, R>,
  selectedRegistry?: ResolvedAuth,
) {
  const authState =
    selectedRegistry === undefined
      ? yield* Registry.credentials().pipe(Effect.result)
      : Result.succeed(selectedRegistry);
  const resolvedRegistry = Result.isSuccess(authState) ? authState.success : undefined;
  const parsed = typeof input === "string" ? yield* parseSkitSource(input) : input;
  // `skit:` shorthand with no Registry configured means the hosted Registry, read anonymously.
  const registry: ResolvedAuth | undefined =
    resolvedRegistry?.origin === undefined && parsed.type === "registry"
      ? { origin: officialRegistryOrigin, source: "none" }
      : resolvedRegistry;
  if (parsed.type === "local") yield* leavePnpmSkill(parsed.path);
  if (parsed.type === "registry" && Result.isFailure(authState))
    return yield* Effect.fail(authState.failure);
  const resolved = yield* resolveSkitSource(input, {
    registryBaseUrl: registry?.origin,
    registryToken: registry?.token,
    ...(previousSkillPaths === undefined ? {} : { previousSkillPaths }),
  });
  yield* leaveResolvedPnpmSkills(parsed, resolved);
  return yield* use({
    parsed,
    resolved,
    historicalInput: typeof input === "string" ? input : sourceLocator(input),
    registryOrigin: registry?.origin,
  });
}, Effect.scoped);

export const inspectLibrarySource = Effect.fn("Library.inspectSource")(function* (
  input: string | SkitSource,
  previousSkillPaths?: readonly string[],
  registry?: ResolvedAuth,
) {
  return yield* withResolvedSource(
    input,
    previousSkillPaths,
    ({ parsed, resolved }) => inspectResolvedSource(parsed, resolved),
    registry,
  );
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

/** Own the retention transaction, including partial commits and temporary-source cleanup. */
export const importSource = Effect.fn("Library.addSource")(function* (
  input: string | SkitSource,
  previousSkillPaths?: readonly string[],
  registry?: ResolvedAuth,
) {
  return yield* withResolvedSource(
    input,
    previousSkillPaths,
    ({ resolved, historicalInput, registryOrigin }) =>
      Effect.gen(function* () {
        const authority =
          resolved.source.type === "registry"
            ? (resolved.source.authority ?? registryOrigin)
            : undefined;
        const declaration =
          resolved.descriptorKind === "declared" && resolved.source.type === "registry"
            ? {
                namespace: resolved.source.namespace,
                slug: resolved.source.slug,
                ...(authority === undefined ? {} : { authority }),
              }
            : undefined;
        const request = {
          source: resolved.source,
          ...(declaration === undefined ? {} : { declaration }),
          input: historicalInput,
          revision: resolved.revision,
          importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        };
        const library = yield* Library.Service;
        const imported =
          resolved.descriptorKind === "declared"
            ? yield* library.import.authored({ ...request, root: resolved.root })
            : yield* library.import.collection({
                ...request,
                skills: yield* describeSourceSkills(resolved, historicalInput),
                lockFileEntries: [],
              });
        return {
          action: imported.action,
          collection_id: imported.collection.collection_id,
          skill_ids: imported.skills.map((skill) => skill.skill_id),
          collection_version_id: imported.collectionVersionId,
          snapshot_digest: imported.snapshotDigest,
          ...(resolved.descriptorKind !== "declared" && resolved.diagnostics?.length
            ? { diagnostics: resolved.diagnostics }
            : {}),
          skills: imported.members.map((member) => ({
            name: member.name,
            verbatim_path: member.sourcePath,
          })),
        };
      }),
    registry,
  );
});
