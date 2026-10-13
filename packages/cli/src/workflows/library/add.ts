import { withLibraryWriter } from "@smolai/skit-core";
import {
  deterministicTreeHashEffect,
  originalTreeHashEffect,
  validateSkitDirectoryEffect,
  readSkitDescriptorEffect,
  parseSkillFrontmatter,
  parseSkitSourceEffect,
  sourceLocator,
  prepareObservedCollectionEffect,
  resolveSkitSourceEffect,
  retainAuthoredCollectionUnderLockEffect,
  retainObservedCollectionEffect,
  LibraryStore,
  type SkitSource,
  type ResolvedSkitSource,
} from "@smolai/skit-core";
import { Data, Clock, Effect, FileSystem } from "effect";
import { basename, dirname, join, relative } from "node:path";
import { RegistryAuth } from "../../registry/auth-service.js";
import { leavePnpmSkillEffect } from "../../projection/pnpm-skills.js";
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
export class AddRetainedVersionMissing
  extends Data.TaggedError("Library.AddRetainedVersionMissing")<{
    source: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Add the source without --version to acquire it again.";
  get message(): string {
    return `The retained version of ${this.source} is missing`;
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
    const descriptor = yield* readSkitDescriptorEffect(resolved.root);
    const memberRoot = join(inputRoot, relative(resolved.originalRoot, resolved.root));
    for (const skill of descriptor.skills) {
      yield* leavePnpmSkillEffect(join(memberRoot, skill.path));
      yield* leavePnpmSkillEffect(join(resolved.root, skill.path));
    }
  } else {
    for (const path of resolved.observedSkillPaths) {
      yield* leavePnpmSkillEffect(join(inputRoot, path));
      yield* leavePnpmSkillEffect(join(resolved.originalRoot, path));
    }
  }
});

export const inspectLibrarySourceEffect = Effect.fn("Library.inspectSource")(function* (
  input: string | SkitSource,
  version?: string,
  previousSkillPaths?: readonly string[],
) {
  const registry = yield* (yield* RegistryAuth).resolve();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const parsed = typeof input === "string" ? yield* parseSkitSourceEffect(input) : input;
      if (parsed.type === "local") yield* leavePnpmSkillEffect(parsed.path);
      if (parsed.type === "registry" && registry.configurationError)
        return yield* Effect.fail(registry.configurationError);
      const resolved = yield* resolveSkitSourceEffect(input, {
        registryBaseUrl: registry.origin,
        registryToken: registry.token,
        ...(version === undefined ? {} : { version }),
        ...(previousSkillPaths === undefined ? {} : { previousSkillPaths }),
      });
      yield* leaveResolvedPnpmSkills(parsed, resolved);
      if (resolved.descriptorKind === "declared") {
        const validated = yield* validateSkitDirectoryEffect(resolved.root, "retained", {
          assessmentContext: "retain",
        });
        return {
          kind: "authored" as const,
          snapshot_digest: yield* originalTreeHashEffect(resolved.root),
          skills: validated.descriptor.skills.map((skill) => ({
            name: skill.name,
            verbatim_path: skill.path,
          })),
        };
      }
      const paths = resolved.observedSkillPaths;
      if (paths.length === 0) return yield* new AddNoSkills({ source: sourceLocator(parsed) });
      const diagnostics = resolved.diagnostics?.length ? { diagnostics: resolved.diagnostics } : {};
      const fs = yield* FileSystem.FileSystem;
      const skills = yield* Effect.forEach(paths, (relativePath) =>
        Effect.gen(function* () {
          const sourcePath =
            relativePath === "."
              ? resolved.originalRoot
              : join(resolved.originalRoot, relativePath);
          const text = yield* fs.readFileString(join(sourcePath, "SKILL.md"));
          const frontmatter = parseSkillFrontmatter(text);
          return {
            name:
              typeof frontmatter?.name === "string" && frontmatter.name.trim()
                ? frontmatter.name.trim()
                : basename(sourcePath),
            sourcePath,
            relativePath,
            observedHash: yield* deterministicTreeHashEffect(sourcePath),
          };
        }),
      );
      const prepared = yield* prepareObservedCollectionEffect(skills);
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

export const previewLibrarySourceEffect = Effect.fn("Library.previewSource")(function* (
  input: string | SkitSource,
  version?: string,
) {
  const inspected = yield* inspectLibrarySourceEffect(input, version);
  return {
    kind: inspected.kind,
    skills: inspected.skills,
    ...("diagnostics" in inspected ? { diagnostics: inspected.diagnostics } : {}),
  };
});

/** Own the retention transaction, including partial commits and temporary-source cleanup. */
export const addLibrarySourceEffect = Effect.fn("Library.addSource")(function* (
  input: string | SkitSource,
  version?: string,
  previousSkillPaths?: readonly string[],
) {
  const registry = yield* (yield* RegistryAuth).resolve();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const parsed = typeof input === "string" ? yield* parseSkitSourceEffect(input) : input;
      if (parsed.type === "local") yield* leavePnpmSkillEffect(parsed.path);
      const historicalInput = typeof input === "string" ? input : sourceLocator(input);
      if (parsed.type === "registry" && registry.configurationError)
        return yield* Effect.fail(registry.configurationError);
      const resolved = yield* resolveSkitSourceEffect(input, {
        registryBaseUrl: registry.origin,
        registryToken: registry.token,
        ...(version === undefined ? {} : { version }),
        ...(previousSkillPaths === undefined ? {} : { previousSkillPaths }),
      });
      yield* leaveResolvedPnpmSkills(parsed, resolved);
      const authority =
        resolved.source.type === "registry"
          ? (resolved.source.authority ?? registry.origin)
          : undefined;
      const declaration =
        resolved.descriptorKind === "declared" && resolved.source.type === "registry"
          ? {
              namespace: resolved.source.namespace,
              slug: resolved.source.slug,
              ...(authority === undefined ? {} : { authority }),
            }
          : undefined;
      if (resolved.descriptorKind === "declared") {
        const snapshot = yield* originalTreeHashEffect(resolved.root);
        const collection = yield* retainAuthoredCollectionUnderLockEffect({
          root: resolved.root,
          source: resolved.source,
          ...(declaration === undefined ? {} : { declaration }),
          input: historicalInput,
          revision: resolved.revision,
          retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        });
        const state = yield* (yield* LibraryStore).load;
        const retained = state.retained_copies.find((copy) => copy.digest === snapshot);
        if (retained === undefined)
          return yield* new AddRetainedVersionMissing({ source: historicalInput });
        const validated = yield* validateSkitDirectoryEffect(resolved.root, "retained", {
          assessmentContext: "retain",
        });
        return {
          ...(collection.collection === undefined
            ? {}
            : { collection_id: collection.collection.collection_id }),
          skill_ids: collection.skills.map((skill) => skill.skill_id),
          retained_version_id: retained.retained_copy_id,
          snapshot_digest: snapshot,
          skills: validated.descriptor.skills.map((skill) => ({
            name: skill.name,
            verbatim_path: skill.path,
          })),
        };
      }
      const paths = resolved.observedSkillPaths;
      if (paths.length === 0) return yield* new AddNoSkills({ source: historicalInput });
      const diagnostics = resolved.diagnostics?.length ? { diagnostics: resolved.diagnostics } : {};
      const fs = yield* FileSystem.FileSystem;
      const skills = yield* Effect.forEach(paths, (relativePath) =>
        Effect.gen(function* () {
          const sourcePath =
            relativePath === "."
              ? resolved.originalRoot
              : join(resolved.originalRoot, relativePath);
          const text = yield* fs.readFileString(join(sourcePath, "SKILL.md"));
          const frontmatter = parseSkillFrontmatter(text);
          const name =
            typeof frontmatter?.name === "string" && frontmatter.name.trim()
              ? frontmatter.name.trim()
              : basename(sourcePath);
          return {
            name,
            sourcePath,
            relativePath,
            observedHash: yield* deterministicTreeHashEffect(sourcePath),
          };
        }),
      );
      const prepared = yield* prepareObservedCollectionEffect(skills);
      const collection = yield* retainObservedCollectionEffect({
        input: historicalInput,
        source: resolved.source,
        ...(declaration === undefined ? {} : { declaration }),
        revision: resolved.revision,
        retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        skills,
        observations: [],
      });
      const state = yield* (yield* LibraryStore).load;
      const retained = state.retained_copies.find((copy) => copy.digest === prepared.digest);
      if (retained === undefined)
        return yield* new AddRetainedVersionMissing({ source: historicalInput });
      return {
        ...(collection.collection === undefined
          ? {}
          : { collection_id: collection.collection.collection_id }),
        skill_ids: collection.skills.map((skill) => skill.skill_id),
        retained_version_id: retained.retained_copy_id,
        snapshot_digest: prepared.digest,
        ...diagnostics,
        skills: prepared.facts.map((skill) => ({
          name: skill.name,
          verbatim_path: skill.sourcePath,
        })),
      };
    }),
  );
}, withLibraryWriter);
