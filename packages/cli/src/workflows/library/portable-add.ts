import {
  collectionRef,
  deterministicTreeHashEffect,
  originalTreeHashEffect,
  validateSkitDirectoryEffect,
  parseSkillFrontmatter,
  parseSkitSourceEffect,
  prepareObservedCollectionEffect,
  resolveSkitSourceEffect,
  retainAuthoredCollectionUnderLockEffect,
  retainObservedCollectionEffect,
  LibraryStore,
} from "@smolai/skit-core";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { basename, join } from "node:path";
import {
  registrySourceDeclaration,
  resolvedCollectionIdentity,
} from "../../library/collection-identity.js";
import { RegistryAuth } from "../../registry/auth-service.js";

export class PortableAddNoSkills extends Schema.TaggedError<PortableAddNoSkills>()(
  "Library.PortableAddNoSkills",
  { source: Schema.String },
) {}
export class PortableAddRetainedVersionMissing extends Schema.TaggedError<PortableAddRetainedVersionMissing>()(
  "Library.PortableAddRetainedVersionMissing",
  { source: Schema.String },
) {}
export class PortableAddIdentityChanged extends Schema.TaggedError<PortableAddIdentityChanged>()(
  "Library.PortableAddIdentityChanged",
  { from: Schema.String, to: Schema.String },
) {}

export interface PortableAddOptions {
  readonly expectedCollectionRef?: string;
  readonly selectVersions?: boolean;
}

export const inspectPortableLibrarySourceEffect = Effect.fn("Library.inspectPortableSource")(
  function* (options: PortableAddOptions, input: string, version?: string) {
    const registry = yield* (yield* RegistryAuth).resolve();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const parsed = yield* parseSkitSourceEffect(input);
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
          return yield* new PortableAddIdentityChanged({
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
          return yield* new PortableAddNoSkills({ source: input });
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
  },
);

export const previewPortableLibrarySourceEffect = Effect.fn("Library.previewPortableSource")(
  function* (options: PortableAddOptions, input: string, version?: string) {
    const inspected = yield* inspectPortableLibrarySourceEffect(options, input, version);
    return { kind: inspected.kind, skills: inspected.skills };
  },
);

/** Retain acquired bytes while the command composition root owns the Library writer lock. */
export const addPortableLibrarySourceEffect = Effect.fn("Library.addPortableSource")(function* (
  options: PortableAddOptions,
  input: string,
  version?: string,
) {
  const registry = yield* (yield* RegistryAuth).resolve();
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const parsed = yield* parseSkitSourceEffect(input);
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
        return yield* new PortableAddIdentityChanged({
          from: options.expectedCollectionRef,
          to: ref,
        });
      if (resolved.descriptorKind === "declared") {
        const snapshot = yield* originalTreeHashEffect(resolved.root);
        const collection = yield* retainAuthoredCollectionUnderLockEffect({
          root: resolved.root,
          identity,
          input,
          retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          selectVersions: options.selectVersions,
        });
        const state = yield* (yield* LibraryStore).load;
        const retained = state.retained_copies.find((copy) => copy.digest === snapshot);
        if (retained === undefined)
          return yield* new PortableAddRetainedVersionMissing({ source: input });
        const validated = yield* validateSkitDirectoryEffect(resolved.root, "retained", {
          assessmentContext: "retain",
        });
        return {
          collection,
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
        return yield* new PortableAddNoSkills({ source: input });
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
        input,
        sourceRevision: resolved.sourceRevision,
        retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        skills,
        observations: [],
        selectVersions: options.selectVersions,
      });
      const state = yield* (yield* LibraryStore).load;
      const retained = state.retained_copies.find((copy) => copy.digest === prepared.digest);
      if (retained === undefined)
        return yield* new PortableAddRetainedVersionMissing({ source: input });
      return {
        collection,
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
