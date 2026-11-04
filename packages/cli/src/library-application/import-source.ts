import { Library } from "@smolai/skit-core/library";
import { officialRegistryOrigin } from "../registry/accounts.js";
import {
  describeSourceSkills,
  inspectResolvedSource,
  leaveResolvedPnpmSkills,
  parseSkitSource,
  sourceLocator,
  resolveSkitSource,
  type ResolvedSkitSource,
  type SkitSource,
} from "@smolai/skit-core";
import { Clock, Effect } from "effect";
import { RegistryAuth } from "../registry/auth-service.js";
import { leavePnpmSkill } from "@smolai/skit-core";

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
) {
  const auth = yield* RegistryAuth;
  const resolvedRegistry = yield* auth.resolve();
  const parsed = typeof input === "string" ? yield* parseSkitSource(input) : input;
  // `skit:` shorthand with no Registry configured means the hosted Registry, read anonymously.
  const registry =
    resolvedRegistry.origin === undefined && parsed.type === "registry"
      ? { ...resolvedRegistry, origin: officialRegistryOrigin }
      : resolvedRegistry;
  if (parsed.type === "local") yield* leavePnpmSkill(parsed.path);
  if (parsed.type === "registry" && registry.configurationError)
    return yield* Effect.fail(registry.configurationError);
  const resolved = yield* resolveSkitSource(input, {
    registryBaseUrl: registry.origin,
    registryToken: registry.token,
    ...(previousSkillPaths === undefined ? {} : { previousSkillPaths }),
  });
  yield* leaveResolvedPnpmSkills(parsed, resolved);
  return yield* use({
    parsed,
    resolved,
    historicalInput: typeof input === "string" ? input : sourceLocator(input),
    registryOrigin: registry.origin,
  });
}, Effect.scoped);

export const inspectLibrarySource = Effect.fn("Library.inspectSource")(function* (
  input: string | SkitSource,
  previousSkillPaths?: readonly string[],
) {
  return yield* withResolvedSource(input, previousSkillPaths, ({ parsed, resolved }) =>
    inspectResolvedSource(parsed, resolved),
  );
});

export const previewLibrarySource = Effect.fn("Library.previewSource")(function* (
  input: string | SkitSource,
) {
  const inspected = yield* inspectLibrarySource(input);
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
  );
});
