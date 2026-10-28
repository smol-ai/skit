import {
  currentSkillVersion,
  invocationMetadataAdapters,
  readSkitDescriptor,
  originalTreeHash,
  ImportContentInvalid,
  resolveDeclaredInvocation,
  collectionVersionPath,
  versionBacking,
  type LibraryState,
  type Skill,
} from "@smolai/skit-core";
import { Cache, Effect, FileSystem, Result } from "effect";
import { join, posix } from "node:path";
import type { AuthorInvocation } from "./read-model.js";
import { errorMessage } from "../failure-classification.js";

export type AuthorInvocationRead = Result.Result<AuthorInvocation, string>;

/** Verify retained bytes and read invocation evidence, without install assessment or writes. */
const readInvocation = Effect.fn("Library.readSkillInvocation")(function* (
  state: LibraryState,
  originalsPath: string,
  skill: Skill,
  hashTree: (path: string) => ReturnType<typeof originalTreeHash>,
) {
  const version = currentSkillVersion(state, skill);
  const backing = version === undefined ? undefined : versionBacking(state, skill, version);
  if (backing === undefined)
    return yield* new ImportContentInvalid({
      diagnostics: [`Skill ${skill.name} has no selected retained backing`],
    });
  const root = collectionVersionPath(originalsPath, backing.copy.hash);
  if ((yield* hashTree(root)) !== backing.copy.hash)
    return yield* new ImportContentInvalid({
      diagnostics: [`Retained copy for ${skill.name} changed`],
    });
  const importedPath = join(root, backing.member.source_path);
  if (version === undefined || (yield* hashTree(importedPath)) !== version.source_hash)
    return yield* new ImportContentInvalid({
      diagnostics: [`Retained Skill ${skill.name} changed`],
    });
  const descriptor =
    backing.member.materialization_profile === "declared-skit-skill/v1"
      ? yield* readSkitDescriptor(root)
      : undefined;
  // Match installedSkillSource: descriptor names choose their declared source directory.
  const member = descriptor?.skills.find((member) => member.name === skill.name);
  if (descriptor !== undefined && member === undefined)
    return yield* new ImportContentInvalid({
      diagnostics: [`Retained descriptor lacks Skill ${skill.name}`],
    });
  const declaring = member ?? { name: skill.name, path: backing.member.source_path };
  const fs = yield* FileSystem.FileSystem;
  const files = new Map<string, string | undefined>();
  for (const adapter of Object.values(invocationMetadataAdapters)) {
    const path = posix.join(declaring.path, adapter.file);
    if (files.has(path)) continue;
    // Shared mappings can supply native metadata absent from the member directory. Read the
    // retained source of that file without staging or assessing an entire artifact to browse it.
    const mapping = member?.shared
      ?.filter(({ to }) => {
        const target = posix.normalize(to);
        return adapter.file === target || adapter.file.startsWith(`${target}/`);
      })
      .toSorted((left, right) => right.to.length - left.to.length)[0];
    const sourcePath =
      mapping === undefined
        ? path
        : posix.join(mapping.from, posix.relative(mapping.to, adapter.file));
    const text = yield* fs
      .readFileString(join(root, sourcePath))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" && !adapter.required
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    files.set(path, text);
  }
  return yield* Effect.fromResult(resolveDeclaredInvocation(declaring, (path) => files.get(path)));
});

/** One reader per Library read pass: copies shared by many Skills are hashed once, including
 * failed reads. A new pass gets fresh hashes. No state or hash result survives a refresh.
 * Checked failures become per-row evidence; defects and interruption still propagate.
 */
export const makeLibrarySkillInvocationReader = Effect.fn("Library.skillInvocationReader")(
  function* (state: LibraryState, originalsPath: string) {
    const hashes = yield* Cache.make({
      capacity: Math.max(1, state.collection_versions.length + state.skills.length),
      lookup: originalTreeHash,
    });
    return (skill: Skill) =>
      readInvocation(state, originalsPath, skill, (path) => Cache.get(hashes, path)).pipe(
        Effect.mapError(errorMessage),
        Effect.result,
      );
  },
);
