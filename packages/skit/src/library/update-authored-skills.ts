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
import type { RemovalDecision } from "../author/inventory.js";
import { inspectAuthorWorkspace } from "../author/inspect.js";
import { readSkitDescriptor } from "../artifact/skit.js";
import { installedSkillHash } from "./installed-skill-hash.js";
import type { InstallDestination } from "../installed-skills/destination.js";

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
export interface AuthoredSkillsUpdate {
  readonly workspaceId: string;
  readonly input: string;
  readonly tree: readonly TreeEntry[];
  readonly revisionId: string;
  readonly savedAt: string;
  readonly removal: RemovalDecision;
}

/** Both preview and update select the same complete inputs in scoped temporary storage. */
const prepareAuthoredUpdate = Effect.fn("Library.prepareAuthoredUpdate")(function* (
  home: string,
  request: AuthoredSkillsUpdate,
  state: LibraryState,
  active: readonly InstallDestination[],
) {
  const fs = yield* FileSystem.FileSystem;
  const collection = state.collections.find((candidate) =>
    sourceImports(state, candidate.collection_id).some(
      (item) =>
        item.source_identity.kind === "authored-workspace" &&
        item.source_identity.workspace_id === request.workspaceId,
    ),
  );
  if (collection === undefined) return undefined;
  const previousImport = sourceImports(state, collection.collection_id)[0];
  const previous = state.collection_versions.find(
    (copy) => copy.collection_version_id === previousImport?.collection_version_id,
  );
  const captured = yield* normalizeAuthorTreeEntries(request.tree);
  for (const entry of captured)
    if (!isCanonicalRelativePath(entry.path))
      return yield* new TreeError({ reason: { _tag: "EscapedPath", path: entry.path } });
  const staging = yield* fs.makeTempDirectoryScoped({ prefix: "skit-authored-update-" });
  for (const entry of captured) {
    if (entry.kind !== "file") continue;
    const path = join(staging, entry.path);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    yield* fs.writeFile(path, entry.bytes, { flag: "wx", mode: entry.mode });
  }
  const previousRoot =
    previous === undefined
      ? undefined
      : yield* readCollectionVersion(libraryOriginalsPath(home), previous.hash);
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
    request.removal,
  );
  return {
    collection,
    previous,
    importedAt,
    root: prepared.root,
    messages: prepared.messages,
    hash: prepared.root === undefined ? previous?.hash : yield* originalTreeHash(prepared.root),
  };
});

/** Select and install complete valid/last-valid input closures under the existing writer. */
export const updateAuthoredSkills = Effect.fn("Library.updateAuthoredSkills")(function* (
  request: AuthoredSkillsUpdate,
  operations: Pick<Interface, "read" | "plan" | "apply">,
) {
  const writer = yield* LibraryWriter;
  const state = yield* loadLibrary(writer.home);
  const installedSkills = yield* InstalledSkills.Service;
  const prepared = yield* prepareAuthoredUpdate(
    writer.home,
    request,
    state,
    yield* installedSkills.active,
  );
  if (prepared === undefined)
    return {
      status: "unregistered" as const,
      installed: 0,
      installed_copies: [],
      messages: [] as string[],
    };
  const { collection, previous, importedAt } = prepared;
  if (prepared.root === undefined)
    return {
      status: "held" as const,
      installed: 0,
      installed_copies: [],
      messages: prepared.messages,
      context: yield* readAuthoredInstallation(state, collection.collection_id),
    };
  const hash = prepared.hash!;
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
    }).pipe(
      Effect.catchTag("UninstallConflict", (error) =>
        Effect.sync(() => {
          messages.push(`${skill.name}: ${error.message}`);
          return undefined;
        }),
      ),
    );
    if (result === undefined) continue;
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

/** A preview cannot name a future Collection Version: changed members have not been saved as
 * Author revisions yet. The private preview provenance is never imported or installed. */
export const inspectAuthoredSkills = Effect.fn("Library.inspectAuthoredSkills")(function* (
  home: string,
  state: LibraryState,
  sourceImport: LibraryState["imports"][number],
  active: readonly InstallDestination[],
) {
  const identity = sourceImport.source_identity;
  if (identity.kind !== "authored-workspace")
    return yield* Effect.die("Expected an authored Source");
  const { tree, removal } = yield* inspectAuthorWorkspace(
    sourceImport.input.value,
    home,
    identity.workspace_id,
  );
  const prepared = yield* prepareAuthoredUpdate(
    home,
    {
      workspaceId: identity.workspace_id,
      input: sourceImport.input.value,
      tree,
      revisionId: "preview",
      savedAt: new Date(0).toISOString(),
      removal,
    },
    state,
    active,
  );
  if (prepared === undefined) return yield* Effect.die("Expected a registered Author Workspace");
  const previous = prepared.previous!;
  if (prepared.root === undefined)
    return {
      kind: "authored" as const,
      snapshot_digest: previous.hash,
      skills: previous.members.map((member) => ({
        name:
          state.skills.find(
            (skill) =>
              skill.collection_id === sourceImport.collection_id &&
              skill.path === member.source_path,
          )?.name ?? member.source_path,
        verbatim_path: member.source_path,
      })),
      members: previous.members,
      messages: prepared.messages,
    };
  const descriptor = yield* readSkitDescriptor(prepared.root);
  const selectedRoot = prepared.root;
  return {
    kind: "authored" as const,
    snapshot_digest: prepared.hash!,
    skills: descriptor.skills.map((skill) => ({ name: skill.name, verbatim_path: skill.path })),
    members: yield* Effect.forEach(descriptor.skills, (skill) =>
      Effect.gen(function* () {
        return {
          source_path: skill.path,
          artifact_hash: yield* installedSkillHash({
            collectionVersionPath: selectedRoot,
            sourcePath: skill.path,
            shared: skill.shared,
          }),
        };
      }),
    ),
    messages: prepared.messages,
  };
}, Effect.scoped);
