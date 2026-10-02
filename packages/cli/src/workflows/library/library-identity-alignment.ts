import { Effect, Schema } from "effect";
import {
  CollectionId,
  SkillId,
  LibraryState,
  LibraryManifest,
  Upstream,
  type BindingEntry,
} from "@smolai/skit-core";

const CollectionAlias = Schema.Struct({ from: CollectionId, to: CollectionId });
const SkillAlias = Schema.Struct({ from: SkillId, to: SkillId });
export const LibraryIdentityAliases = Schema.Struct({
  collections: Schema.Array(CollectionAlias),
  skills: Schema.Array(SkillAlias),
});
export type LibraryIdentityAliases = typeof LibraryIdentityAliases.Type;

const collectionId = (id: CollectionId, aliases: LibraryIdentityAliases) =>
  aliases.collections.find((alias) => alias.from === id)?.to ?? id;
const skillId = (id: SkillId, aliases: LibraryIdentityAliases) =>
  aliases.skills.find((alias) => alias.from === id)?.to ?? id;
const bindingEntry = (entry: BindingEntry, aliases: LibraryIdentityAliases): BindingEntry =>
  entry.kind === "collection"
    ? { ...entry, collection_id: collectionId(entry.collection_id, aliases) }
    : { ...entry, skill_id: skillId(entry.skill_id, aliases) };

/** Only independently added Collections may adopt an existing upstream/tracking identity. */
export const alignLibraryIdentitiesEffect = Effect.fn("Library.sync.alignIdentities")(function* (
  local: LibraryManifest,
  remote: LibraryManifest,
  base: LibraryManifest,
) {
  const collections: (typeof CollectionAlias.Type)[] = [];
  const skills: (typeof SkillAlias.Type)[] = [];
  for (const collection of local.collections) {
    const upstream = collection.upstream;
    if (
      upstream === undefined ||
      [...base.collections, ...remote.collections].some(
        (item) => item.collection_id === collection.collection_id,
      )
    )
      continue;
    const published = remote.collections.find(
      (item) =>
        item.upstream !== undefined && Schema.toEquivalence(Upstream)(upstream, item.upstream),
    );
    if (published === undefined) continue;
    collections.push({ from: collection.collection_id, to: published.collection_id });
  }
  for (const skill of local.skills) {
    if ([...base.skills, ...remote.skills].some((item) => item.skill_id === skill.skill_id))
      continue;
    const collection =
      collections.find((alias) => alias.from === skill.collection_id)?.to ?? skill.collection_id;
    const counterpart = remote.skills.find(
      (item) => item.collection_id === collection && item.path === skill.path,
    );
    if (
      counterpart !== undefined &&
      !base.skills.some((item) => item.skill_id === counterpart.skill_id)
    )
      skills.push({ from: skill.skill_id, to: counterpart.skill_id });
  }
  const aliases = yield* LibraryIdentityAliases.makeEffect({ collections, skills });
  return { manifest: yield* applyLibraryIdentityAliasesEffect(local, aliases), aliases };
});

export const applyLibraryIdentityAliasesEffect = Effect.fn("Library.sync.aliasManifest")(function* (
  manifest: LibraryManifest,
  aliases: LibraryIdentityAliases,
) {
  return yield* LibraryManifest.makeEffect({
    ...manifest,
    collections: manifest.collections.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    skills: manifest.skills.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
      skill_id: skillId(item.skill_id, aliases),
    })),
    acquisitions: manifest.acquisitions.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    bindings: manifest.bindings.map((binding) => ({
      ...binding,
      entries: binding.entries.map((entry) => bindingEntry(entry, aliases)),
    })),
  });
});

/** References move together; on-disk ownership must be retired before publishing these aliases. */
export const applyDeviceIdentityAliasesEffect = Effect.fn("Library.sync.aliasDevice")(function* (
  state: LibraryState,
  aliases: LibraryIdentityAliases,
) {
  const policies = (
    binding: LibraryState["global_bindings"][number] | LibraryState["local_bindings"][number],
  ) =>
    binding.invocation_policies === undefined
      ? {}
      : {
          invocation_policies: Object.fromEntries(
            Object.entries(binding.invocation_policies).map(([id, policy]) => [
              aliases.skills.find((alias) => alias.from === id)?.to ?? id,
              policy,
            ]),
          ),
        };
  return yield* LibraryState.makeEffect({
    ...state,
    collections: state.collections.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    skills: state.skills.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
      skill_id: skillId(item.skill_id, aliases),
    })),
    acquisitions: state.acquisitions.map((item) => ({
      ...item,
      collection_id: collectionId(item.collection_id, aliases),
    })),
    global_bindings: state.global_bindings.map((binding) => ({
      ...binding,
      ...policies(binding),
      entries: binding.entries.map((entry) => bindingEntry(entry, aliases)),
    })),
    local_bindings: state.local_bindings.map((binding) => ({
      ...binding,
      ...policies(binding),
      entries: binding.entries.map((entry) => bindingEntry(entry, aliases)),
    })),
    projections: state.projections.map((projection) => ({
      ...projection,
      skill_id: skillId(projection.skill_id, aliases),
    })),
    ...(state.custodyIssues === undefined
      ? {}
      : {
          custodyIssues: state.custodyIssues.map((issue) => ({
            ...issue,
            ...(issue.skillId === undefined ? {} : { skillId: skillId(issue.skillId, aliases) }),
            ...(issue.collectionId === undefined
              ? {}
              : { collectionId: collectionId(issue.collectionId, aliases) }),
          })),
        }),
  });
});
