import {
  currentSkillVersion,
  readSkitDescriptorEffect,
  retainedTreePath,
  versionBacking,
  type LibraryState,
  type SkitDescriptor,
  type SourceIdentity,
} from "@smolai/skit-core";
import { Effect, FileSystem, Option, Schema } from "effect";
import { join } from "node:path";

export const SkillMetadata = Schema.Struct({
  source: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.String),
  source_updated_at: Schema.NullOr(Schema.String),
  /** When the selected bytes were acquired; this is not a source modification time. */
  acquired_at: Schema.NullOr(Schema.String),
});
export type SkillMetadata = typeof SkillMetadata.Type;

export const sourceIdentityLabel = (source: SourceIdentity): string => {
  switch (source.kind) {
    case "github":
      return `${source.owner}/${source.repository}${source.collection_root === "." ? "" : `/${source.collection_root}`}`;
    case "git":
      return `${source.remote.value}${source.collection_root === "." ? "" : `/${source.collection_root}`}`;
    case "registry":
      return `${source.authority.replace(/\/+$/, "")}/${source.namespace}/${source.slug}`;
    case "url":
    case "archive":
      return source.url.value;
    case "local":
      return source.path.value;
    case "authored-workspace":
      return `authored:${source.workspace_id}`;
    case "well-known":
      return source.locator.value;
  }
};

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
    const acquisition = backing?.acquisition;
    const source =
      acquisition?.source_identity ??
      state.collections.find((collection) => collection.collection_id === skill.collection_id)
        ?.upstream?.source_identity;
    let sourceUpdated: string | null = null;
    // Observations whose bytes disagree cannot establish the selected Skill's source date.
    const dates =
      acquisition?.observations
        .filter(
          (observation) =>
            observation.content_agreement === "agrees" &&
            observation.skill_name === skill.name &&
            (observation.skill_path === undefined || observation.skill_path === skill.path),
        )
        .flatMap((observation) => {
          const date = validTimestamp(observation.source_updated_at);
          return date === null ? [] : [date];
        }) ?? [];
    // Contradictory observations do not establish a single date.
    if (new Set(dates).size === 1) sourceUpdated = dates[0]!;
    if (backing?.member.materialization_profile === "declared-skit-skill/v1") {
      if (!descriptors.has(backing.copy.digest))
        descriptors.set(
          backing.copy.digest,
          yield* readSkitDescriptorEffect(
            retainedTreePath(originalsPath, backing.copy.digest),
          ).pipe(Effect.orElseSucceed(() => undefined)),
        );
      const descriptor = descriptors
        .get(backing.copy.digest)
        ?.skills.find(
          (member) => member.path === backing.member.source_path && member.name === skill.name,
        );
      sourceUpdated = validTimestamp(descriptor?.source_updated_at) ?? sourceUpdated;
    }
    metadata.set(skill.skill_id, {
      source: source === undefined ? null : sourceIdentityLabel(source),
      revision: acquisition?.revision ?? null,
      source_updated_at: sourceUpdated,
      acquired_at: validTimestamp(acquisition?.acquired_at),
    });
  }
  return metadata;
});
