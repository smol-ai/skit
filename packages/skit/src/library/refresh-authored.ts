import { Clock, Effect, FileSystem, Schema } from "effect";
import { dirname, join } from "node:path";
import type { TreeEntry } from "../artifact/tree-entry.js";
import { normalizeAuthorTreeEntries } from "../artifact/tree.js";
import type { TreeFile } from "../artifact/tree-entry.js";
import { isCanonicalRelativePath } from "../shared/relative-path.js";
import { TreeError } from "../shared/tree-error.js";
import type { Interface } from "./library.js";
import { sourceImports, currentCollectionSkills, enabledSkillIds } from "./library-contracts.js";
import { originalTreeHash } from "./collection-version.js";
import { readCollectionVersion } from "./internal/content/read-collection-version.js";
import { importAuthoredCollection } from "./import-collection.js";
import { LibraryWriter, libraryOriginalsPath, loadLibrary } from "./store/library-store.js";
import { prepareAuthored } from "./internal/content/prepare-authored.js";
import * as InstalledSkills from "./installed-skills.js";
import { CollectionSource, readCollectionSource } from "./collection-source.js";
import type { LibraryState } from "./library-state.js";

export const AuthoredInstalledCopy = Schema.Struct({ skill: Schema.String, path: Schema.String });

export const AuthoredInstallation = Schema.Struct({
  collection_label: Schema.String,
  source: Schema.optionalKey(CollectionSource),
  disabled_skills: Schema.Array(Schema.String),
  total: Schema.Int,
  other_sources: Schema.Array(
    Schema.Struct({
      skill: Schema.String,
      path: Schema.String,
      collection_label: Schema.String,
      source: Schema.optionalKey(CollectionSource),
    }),
  ),
});

const readAuthoredInstallation = Effect.fn("Library.readAuthoredInstallation")(function* (
  state: LibraryState,
  collectionId: string,
) {
  const collection = state.collections.find((item) => item.collection_id === collectionId)!;
  const members = currentCollectionSkills(state, collection.collection_id);
  const enabled = new Set(
    [state.enabled, ...state.repositories.map((repository) => repository.enabled)].flatMap(
      (items) => enabledSkillIds(state, items),
    ),
  );
  const otherSources = [];
  for (const copy of state.installed_skills) {
    const skill = state.skills.find((item) => item.skill_id === copy.skill_id);
    if (
      skill === undefined ||
      skill.collection_id === collectionId ||
      !members.some((member) => member.name === skill.name)
    )
      continue;
    const owner = state.collections.find((item) => item.collection_id === skill.collection_id);
    if (owner === undefined) continue;
    otherSources.push({
      skill: skill.name,
      path: copy.path,
      collection_label: owner.label,
      source: yield* readCollectionSource(state, owner),
    });
  }
  return {
    collection_label: collection.label,
    source: yield* readCollectionSource(state, collection),
    disabled_skills: members
      .filter((member) => !enabled.has(member.skill_id))
      .map((member) => member.name),
    total: members.length,
    other_sources: otherSources,
  };
});

/** Bytes already preserved by Author history; the Library never reads the editable root. */
export interface AuthoredRefresh {
  readonly workspaceId: string;
  readonly input: string;
  readonly tree: readonly TreeEntry[];
  readonly revisionId: string;
  readonly savedAt: string;
}

/** Select and install complete valid/last-valid input closures under the existing writer. */
export const refreshAuthored = Effect.fn("Library.refreshAuthored")(function* (
  request: AuthoredRefresh,
  operations: Pick<Interface, "read" | "plan" | "apply">,
) {
  const writer = yield* LibraryWriter;
  const fs = yield* FileSystem.FileSystem;
  const installedSkills = yield* InstalledSkills.Service;
  const active = yield* installedSkills.active;
  const state = yield* loadLibrary(writer.home);
  const collection = state.collections.find((candidate) =>
    sourceImports(state, candidate.collection_id).some(
      (item) =>
        item.source_identity.kind === "authored-workspace" &&
        item.source_identity.workspace_id === request.workspaceId,
    ),
  );
  if (collection === undefined)
    return {
      status: "unregistered" as const,
      installed: 0,
      installed_copies: [],
      messages: [] as string[],
    };
  const previousImport = sourceImports(state, collection.collection_id)[0];
  const previous = state.collection_versions.find(
    (copy) => copy.collection_version_id === previousImport?.collection_version_id,
  );
  const captured = yield* normalizeAuthorTreeEntries(request.tree);
  for (const entry of captured)
    if (!isCanonicalRelativePath(entry.path))
      return yield* new TreeError({ reason: { _tag: "EscapedPath", path: entry.path } });
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "skit-authored-refresh-" });
  for (const entry of captured) {
    if (entry.kind !== "file") continue;
    const path = join(staging, entry.path);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* fs.writeFile(path, entry.bytes, { flag: "wx", mode: entry.mode });
  }
  const previousRoot =
    previous === undefined
      ? undefined
      : yield* readCollectionVersion(libraryOriginalsPath(writer.home), previous.hash);
  const importedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const prepared = yield* prepareAuthored(
    staging,
    captured.filter((entry): entry is TreeFile => entry.kind === "file"),
    { revisionId: request.revisionId, savedAt: request.savedAt, importedAt },
    previousRoot === undefined || previousImport === undefined
      ? undefined
      : { root: previousRoot, importedAt: previousImport.imported_at },
    active.map((destination) =>
      destination === "agents" ? ("codex" as const) : ("claude-code" as const),
    ),
  );
  if (prepared.root === undefined)
    return {
      status: "held" as const,
      installed: 0,
      installed_copies: [],
      messages: prepared.messages,
      context: yield* readAuthoredInstallation(state, collection.collection_id),
    };
  const hash = yield* originalTreeHash(prepared.root);
  if (hash !== previous?.hash)
    yield* importAuthoredCollection({
      root: prepared.root,
      input: request.input,
      source: { type: "local", path: request.input },
      sourceIdentity: { kind: "authored-workspace", workspace_id: request.workspaceId },
      label: collection.label,
      importedAt,
    });
  const current = yield* loadLibrary(writer.home);
  const messages = [...prepared.messages];
  const installedCopies: Array<typeof AuthoredInstalledCopy.Type> = [];
  // One changed installed folder must not block unrelated Skills. No replacement approvals.
  for (const skill of current.skills.filter(
    (skill) => skill.collection_id === collection.collection_id,
  )) {
    const result = yield* Effect.gen(function* () {
      const base = yield* operations.read;
      const plan = yield* operations.plan({ _tag: "Install", skills: [skill.skill_id] }, { base });
      return (yield* operations.apply({ _tag: "Apply", plan })).result;
    });
    if (result._tag === "Applied") {
      for (const copy of result.copies) {
        if (copy._tag === "Installed")
          installedCopies.push({ skill: skill.name, path: copy.copy.path });
        if (copy._tag === "Failed")
          messages.push(`${skill.name} at ${copy.path}: ${copy.cause.message}`);
        if (copy._tag === "Conflicted" || copy._tag === "Pending")
          messages.push(
            `${skill.name} at ${copy.copy.path}: ${copy._tag === "Conflicted" ? "copy conflicts with the retained version; left unchanged" : "installation is pending"}`,
          );
      }
    } else
      messages.push(
        `${skill.name}${result.failedPaths?.length ? ` at ${result.failedPaths.join(", ")}` : ""}: ${result.cause.message}`,
      );
  }
  return {
    status: hash === previous?.hash ? ("unchanged" as const) : ("updated" as const),
    installed: installedCopies.length,
    installed_copies: installedCopies,
    messages,
    context: yield* readAuthoredInstallation(current, collection.collection_id),
  };
});
