import { officialRegistryOrigin } from "../registry/accounts.js";
import { withLibraryWriter } from "@smolai/skit-core";
import {
  deterministicTreeHash,
  originalTreeHash,
  validateSkitDirectory,
  readSkitDescriptor,
  parseSkillFrontmatter,
  parseSkitSource,
  sourceLocator,
  prepareImport,
  resolveSkitSource,
  importAuthoredCollection,
  importCollection,
  type SkitSource,
  type ResolvedSkitSource,
} from "@smolai/skit-core";
import { Data, Clock, Effect, FileSystem } from "effect";
import { basename, dirname, join, relative } from "node:path";
import { RegistryAuth } from "../registry/auth-service.js";
import { leavePnpmSkill } from "../install/pnpm-skills.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class AddNoSkills
  extends Data.TaggedError("Library.AddNoSkills")<{ source: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Choose a source that contains a SKILL.md.";
  get message(): string {
    return `No Skills found in ${this.source}`;
  }
}
/** Check every selected local member before retaining any bytes, including declared collections.
 * Preserve the caller's dependency view when resolution canonicalizes or stages directory links.
 */
const leaveResolvedPnpmSkills = Effect.fn("Library.leaveResolvedPnpmSkills")(function* (
  source: SkitSource,
  resolved: ResolvedSkitSource,
) {
  if (source.type !== "local") return;
  const inputRoot = basename(source.path) === "SKILL.md" ? dirname(source.path) : source.path;
  if (resolved.descriptorKind === "declared") {
    const descriptor = yield* readSkitDescriptor(resolved.root);
    const memberRoot = join(inputRoot, relative(resolved.originalRoot, resolved.root));
    for (const skill of descriptor.skills) {
      yield* leavePnpmSkill(join(memberRoot, skill.path));
      yield* leavePnpmSkill(join(resolved.root, skill.path));
    }
  } else {
    for (const path of resolved.observedSkillPaths) {
      yield* leavePnpmSkill(join(inputRoot, path));
      yield* leavePnpmSkill(join(resolved.originalRoot, path));
    }
  }
});

/** Describe plain source members once, before retention verifies and stages those observations. */
const describeSourceSkills = Effect.fn("Library.describeSourceSkills")(function* (
  resolved: Extract<ResolvedSkitSource, { descriptorKind: "observed" }>,
  sourceLabel: string,
) {
  if (resolved.observedSkillPaths.length === 0)
    return yield* new AddNoSkills({ source: sourceLabel });
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(resolved.observedSkillPaths, (relativePath) =>
    Effect.gen(function* () {
      const sourcePath =
        relativePath === "." ? resolved.originalRoot : join(resolved.originalRoot, relativePath);
      const text = yield* fs.readFileString(join(sourcePath, "SKILL.md"));
      const frontmatter = parseSkillFrontmatter(text);
      return {
        name:
          typeof frontmatter?.name === "string" && frontmatter.name.trim()
            ? frontmatter.name.trim()
            : basename(sourcePath),
        sourcePath,
        relativePath,
        currentHash: yield* deterministicTreeHash(sourcePath),
      };
    }),
  );
});

/** Resolve once inside the lifetime of the operation consuming the staged source. */
const withResolvedSource = Effect.fn("SourceAcquisition.withResolvedSource")(function* <A, E, R>(
  input: string | SkitSource,
  version: string | undefined,
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
    ...(version === undefined ? {} : { version }),
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
  version?: string,
  previousSkillPaths?: readonly string[],
) {
  return yield* withResolvedSource(input, version, previousSkillPaths, ({ parsed, resolved }) =>
    Effect.gen(function* () {
      if (resolved.descriptorKind === "declared") {
        const validated = yield* validateSkitDirectory(resolved.root, "retained", {
          assessmentContext: "import",
        });
        return {
          kind: "authored" as const,
          snapshot_digest: yield* originalTreeHash(resolved.root),
          skills: validated.descriptor.skills.map((skill) => ({
            name: skill.name,
            verbatim_path: skill.path,
          })),
        };
      }
      const skills = yield* describeSourceSkills(resolved, sourceLocator(parsed));
      const diagnostics = resolved.diagnostics?.length ? { diagnostics: resolved.diagnostics } : {};
      const prepared = yield* prepareImport(skills);
      return {
        kind: "plain" as const,
        ...diagnostics,
        snapshot_digest: prepared.digest,
        skills: prepared.facts.map((skill) => ({
          name: skill.name,
          verbatim_path: skill.sourcePath,
        })),
        /** Per-Skill bytes, so a refresh preview can tell which Skills changed. */
        members: prepared.facts.map((skill) => ({
          source_path: skill.sourcePath,
          artifact_digest: skill.artifactDigest,
        })),
      };
    }),
  );
});

export const previewLibrarySource = Effect.fn("Library.previewSource")(function* (
  input: string | SkitSource,
  version?: string,
) {
  const inspected = yield* inspectLibrarySource(input, version);
  return {
    kind: inspected.kind,
    skills: inspected.skills,
    ...("diagnostics" in inspected ? { diagnostics: inspected.diagnostics } : {}),
  };
});

/** Own the retention transaction, including partial commits and temporary-source cleanup. */
export const importSource = Effect.fn("Library.addSource")(function* (
  input: string | SkitSource,
  version?: string,
  previousSkillPaths?: readonly string[],
) {
  return yield* withResolvedSource(
    input,
    version,
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
        const imported =
          resolved.descriptorKind === "declared"
            ? yield* importAuthoredCollection({ ...request, root: resolved.root })
            : yield* importCollection({
                ...request,
                skills: yield* describeSourceSkills(resolved, historicalInput),
                observations: [],
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
}, withLibraryWriter);
