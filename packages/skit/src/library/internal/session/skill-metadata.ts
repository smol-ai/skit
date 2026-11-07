import { sourceIdentityLabel } from "../../source-identity.js";
export { sourceIdentityLabel } from "../../source-identity.js";
import { currentSkillVersion, versionBacking } from "../../library-contracts.js";
import { readSkitDescriptor } from "../../../artifact/skit.js";
import { collectionVersionPath } from "../../collection-version.js";
import { type LibraryState } from "../../library-state.js";
import { type SkitDescriptor } from "../../../artifact/schemas.js";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";

export const SkillMetadata = Schema.Struct({
  source: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  source_updated_at: Schema.NullOr(Schema.String),
  /** When the selected bytes were acquired; this is not a source modification time. */
  imported_at: Schema.NullOr(Schema.String),
});
export type SkillMetadata = typeof SkillMetadata.Type;

/** Read the original file's date, following symlinks. Never substitute an observation time. */
export const skillModificationTime = Effect.fn("Library.skillModificationTime")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(join(path, "SKILL.md")).pipe(
    Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (date) => date.toISOString()))),
    Effect.orElseSucceed(() => null),
  );
});

const validTimestamp = (value: string | undefined): string | null =>
  value === undefined || Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();

/** Provenance belongs to the selected retained bytes, not the Collection's latest acquisition. */
export const readLibrarySkillMetadata = Effect.fn("Library.readSkillMetadata")(function* (
  state: LibraryState,
  originalsPath: string,
) {
  const metadata = new Map<string, SkillMetadata>();
  const descriptors = new Map<string, SkitDescriptor | undefined>();
  for (const skill of state.skills) {
    const selected = currentSkillVersion(state, skill);
    const backing = selected === undefined ? undefined : versionBacking(state, skill, selected);
    const sourceImport = backing?.acquisition;
    const source =
      sourceImport?.source_identity ??
      state.collections.find((collection) => collection.collection_id === skill.collection_id)
        ?.upstream?.source_identity;
    let sourceUpdated: string | null = null;
    // Lock file entries whose bytes disagree cannot establish the selected Skill's source date.
    const dates =
      sourceImport?.lock_file_entries
        .filter(
          (lockFileEntry) =>
            lockFileEntry.content_agreement === "agrees" &&
            lockFileEntry.skill_name === skill.name &&
            (lockFileEntry.skill_path === undefined || lockFileEntry.skill_path === skill.path),
        )
        .flatMap((lockFileEntry) => {
          const date = validTimestamp(lockFileEntry.source_updated_at);
          return date === null ? [] : [date];
        }) ?? [];
    // Contradictory observations do not establish a single date.
    if (new Set(dates).size === 1) sourceUpdated = dates[0]!;
    if (backing?.member.materialization_profile === "declared-skit-skill/v1") {
      if (!descriptors.has(backing.copy.hash))
        descriptors.set(
          backing.copy.hash,
          yield* readSkitDescriptor(collectionVersionPath(originalsPath, backing.copy.hash)).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        );
      const descriptor = descriptors
        .get(backing.copy.hash)
        ?.skills.find(
          (member) => member.path === backing.member.source_path && member.name === skill.name,
        );
      sourceUpdated = validTimestamp(descriptor?.source_updated_at) ?? sourceUpdated;
    }
    metadata.set(skill.skill_id, {
      source: source === undefined ? null : sourceIdentityLabel(source),
      revision: sourceImport?.revision ?? null,
      source_updated_at: sourceUpdated,
      imported_at: validTimestamp(sourceImport?.imported_at),
    });
  }
  return metadata;
});

/** Metadata and lazy content reads for copies already selected by an owner-backed review. */
export const readSkillPreviews = Effect.fn("Library.readSkillPreviews")(function* (
  paths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      return {
        path,
        documentPath: join(path, "SKILL.md"),
        modifiedAt: yield* skillModificationTime(path),
        content: fs
          .readFileString(join(path, "SKILL.md"))
          .pipe(Effect.orElseSucceed(() => undefined)),
      };
    }),
  );
});
