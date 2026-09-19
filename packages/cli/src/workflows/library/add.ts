import {
  collectionRef,
  deterministicTreeHashEffect,
  originalTreeHashEffect,
  validateSkitDirectoryEffect,
  parseSkillFrontmatter,
  parseSkitSourceEffect,
  sourceLocator,
  prepareObservedCollectionEffect,
  resolveSkitSourceEffect,
  retainAuthoredCollectionUnderLockEffect,
  retainObservedCollectionEffect,
  LibraryStore,
  type Acquisition,
  type SkitSource,
} from "@smolai/skit-core";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { basename, join } from "node:path";
import {
  registrySourceDeclaration,
  resolvedCollectionIdentity,
} from "../../library/collection-identity.js";
import { RegistryAuth } from "../../registry/auth-service.js";

export class AddNoSkills extends Schema.TaggedError<AddNoSkills>()("Library.AddNoSkills", {
  source: Schema.String,
}) {}
export class AddRetainedVersionMissing extends Schema.TaggedError<AddRetainedVersionMissing>()(
  "Library.AddRetainedVersionMissing",
  { source: Schema.String },
) {}
export class AddIdentityChanged extends Schema.TaggedError<AddIdentityChanged>()(
  "Library.AddIdentityChanged",
  { from: Schema.String, to: Schema.String },
) {}

export interface AddOptions {
  readonly expectedCollectionRef?: string;
  readonly selectVersions?: boolean;
  readonly standalone?: boolean;
}

export const acquisitionSourceEffect = Effect.fn("Library.acquisitionSource")(function* (
  acquisition: Acquisition,
) {
  const source = yield* parseSkitSourceEffect(acquisition.input.value);
  return source.type === "well-known" && acquisition.selection.kind === "selected-skills"
    ? { ...source, members: acquisition.selection.names }
    : source;
});

export const inspectLibrarySourceEffect = Effect.fn("Library.inspectSource")(function* (
  options: AddOptions,
  input: string | SkitSource,
  version?: string,
) {
  const registry = yield* (yield* RegistryAuth).resolve();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const parsed = typeof input === "string" ? yield* parseSkitSourceEffect(input) : input;
      if (parsed.type === "registry" && registry.configurationError)
        return yield* Effect.fail(registry.configurationError);
      const resolved = yield* resolveSkitSourceEffect(input, {
        registryBaseUrl: registry.origin,
        registryToken: registry.token,
        ...(version === undefined ? {} : { version }),
        verbatimOnly: true,
      });
      const identity = resolvedCollectionIdentity(
        resolved.source,
        resolved.descriptorKind,
        registrySourceDeclaration(resolved.source, registry.origin),
      );
      const ref = collectionRef(identity);
      if (options.expectedCollectionRef !== undefined && ref !== options.expectedCollectionRef)
        return yield* new AddIdentityChanged({
          from: options.expectedCollectionRef,
          to: ref,
        });
      if (resolved.descriptorKind === "declared") {
        const validated = yield* validateSkitDirectoryEffect(resolved.root, "retained", {
          assessmentContext: "retain",
        });
        return {
          kind: "authored" as const,
          identity,
          snapshot_digest: yield* originalTreeHashEffect(resolved.root),
          skills: validated.descriptor.skills.map((skill) => ({
            name: skill.name,
            verbatim_path: skill.path,
          })),
        };
      }
      const paths = resolved.observedSkillPaths;
      if (paths === undefined || paths.length === 0)
        return yield* new AddNoSkills({ source: sourceLocator(parsed) });
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
        identity,
        snapshot_digest: prepared.digest,
        skills: prepared.facts.map((skill) => ({
          name: skill.name,
          verbatim_path: skill.sourcePath,
        })),
      };
    }),
  );
});

export const previewLibrarySourceEffect = Effect.fn("Library.previewSource")(function* (
  options: AddOptions,
  input: string | SkitSource,
  version?: string,
) {
  const inspected = yield* inspectLibrarySourceEffect(options, input, version);
  return { kind: inspected.kind, skills: inspected.skills };
});

/** Retain acquired bytes while the command composition root owns the Library writer lock. */
export const addLibrarySourceEffect = Effect.fn("Library.addSource")(function* (
  options: AddOptions,
  input: string | SkitSource,
  version?: string,
) {
  const registry = yield* (yield* RegistryAuth).resolve();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const parsed = typeof input === "string" ? yield* parseSkitSourceEffect(input) : input;
      const historicalInput = typeof input === "string" ? input : sourceLocator(input);
      if (parsed.type === "registry" && registry.configurationError)
        return yield* Effect.fail(registry.configurationError);
      const resolved = yield* resolveSkitSourceEffect(input, {
        registryBaseUrl: registry.origin,
        registryToken: registry.token,
        ...(version === undefined ? {} : { version }),
        verbatimOnly: true,
      });
      const identity = resolvedCollectionIdentity(
        resolved.source,
        resolved.descriptorKind,
        registrySourceDeclaration(resolved.source, registry.origin),
      );
      const ref = collectionRef(identity);
      if (options.expectedCollectionRef !== undefined && ref !== options.expectedCollectionRef)
        return yield* new AddIdentityChanged({
          from: options.expectedCollectionRef,
          to: ref,
        });
      if (resolved.descriptorKind === "declared") {
        const snapshot = yield* originalTreeHashEffect(resolved.root);
        const collection = yield* retainAuthoredCollectionUnderLockEffect({
          root: resolved.root,
          identity,
          input: historicalInput,
          retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          selectVersions: options.selectVersions,
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
      if (paths === undefined || paths.length === 0)
        return yield* new AddNoSkills({ source: historicalInput });
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
        identity,
        input: historicalInput,
        source: resolved.source,
        sourceRevision: resolved.sourceRevision,
        retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        skills,
        observations: [],
        selectVersions: options.selectVersions,
        standalone: options.standalone,
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
        skills: prepared.facts.map((skill) => ({
          name: skill.name,
          verbatim_path: skill.sourcePath,
        })),
      };
    }),
  );
});
