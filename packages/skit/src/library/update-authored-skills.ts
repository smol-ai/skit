import { AuthorRemoteHome } from "../author/remote.js";
import { readCatalogue } from "./store/catalogue.js";
import { LibraryChanged } from "./failures.js";
import type { AuthoredSkillIssue } from "./authored-skill-issues.js";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { dirname, join } from "node:path";
import type { TreeEntry } from "../artifact/tree-entry.js";
import { normalizeAuthorTreeEntries } from "../artifact/tree.js";
import type { TreeFile } from "../artifact/tree-entry.js";
import { isCanonicalRelativePath } from "../shared/relative-path.js";
import { TreeError } from "../shared/tree-error.js";
import type { Interface } from "./library.js";
import {
  sourceImports,
  selectedSourceImport,
  currentCollectionSkills,
  enabledSkillIds,
  type Import,
  type CollectionVersion,
} from "./library-contracts.js";
import { originalTreeHash } from "./collection-version.js";
import { readCollectionVersion } from "./internal/content/read-collection-version.js";
import { importAuthoredCollection } from "./import-collection.js";
import { LibraryWriter, libraryOriginalsPath, loadLibrary } from "./store/library-store.js";
import { prepareAuthored } from "./internal/content/prepare-authored.js";
import * as InstalledSkills from "./installed-skills.js";
import {
  CollectionSource,
  localWorkspace,
  readCollectionSource,
  workspaceLookup,
  type WorkspaceLookup,
} from "./collection-source.js";
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
  lookup: WorkspaceLookup,
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
      source: yield* readCollectionSource(state, owner, lookup),
    });
  }
  return {
    collection_label: collection.label,
    source: yield* readCollectionSource(state, collection, lookup),
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
  readonly draftHome?: AuthorRemoteHome;
  readonly expectedImportId?: string;
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
  previous: { readonly version: CollectionVersion; readonly importedAt: string } | undefined,
  active: readonly InstallDestination[],
) {
  const fs = yield* FileSystem.FileSystem;
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
  const previousCollection =
    previous === undefined
      ? undefined
      : {
          root: yield* readCollectionVersion(libraryOriginalsPath(home), previous.version.hash),
          importedAt: previous.importedAt,
        };
  const importedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
  const prepared = yield* prepareAuthored(
    staging,
    captured.filter((entry): entry is TreeFile => entry.kind === "file"),
    { revisionId: request.revisionId, savedAt: request.savedAt, importedAt },
    previousCollection,
    active.map((destination) =>
      destination === "agents" ? ("codex" as const) : ("claude-code" as const),
    ),
    request.removal,
  );
  if (prepared.root === undefined) return { root: undefined, issues: prepared.issues };
  return {
    root: prepared.root,
    issues: prepared.issues,
    importedAt,
    hash: yield* originalTreeHash(prepared.root),
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
  const active = yield* installedSkills.active;
  const lookup = yield* workspaceLookup(writer.home);
  const matches = [];
  for (const candidate of state.collections) {
    const upstream = candidate.upstream;
    if (upstream?.source_identity.kind !== "authored-workspace") continue;
    if (upstream.draft_home) {
      if (
        !request.draftHome ||
        !Schema.toEquivalence(AuthorRemoteHome)(request.draftHome, upstream.draft_home)
      )
        continue;
      const workspace = yield* localWorkspace(state, candidate, lookup);
      if (workspace?.workspaceId !== request.workspaceId || workspace.path !== request.input)
        continue;
    } else if (upstream.source_identity.workspace_id !== request.workspaceId) continue;
    matches.push(candidate);
  }
  if (matches.length > 1) return yield* new LibraryChanged({ path: writer.home });
  const collection = matches[0];
  if (
    request.expectedImportId !== undefined &&
    (collection === undefined ||
      selectedSourceImport(state, collection.collection_id)?.import_id !== request.expectedImportId)
  )
    return yield* new LibraryChanged({ path: writer.home });
  if (!collection?.upstream)
    return {
      status: "unregistered" as const,
      installed: 0,
      installed_copies: [],
      issues: [] as AuthoredSkillIssue[],
    };
  // An offline observation can update a local installation. Only a checkpoint from
  // this workspace may introduce a Registry address into the portable catalogue.
  let connected = collection.upstream?.draft_home !== undefined;
  if (
    request.draftHome &&
    !collection.upstream.draft_home &&
    (yield* lookup.drafts)(request.draftHome).some(
      (location) => location.workspaceId === request.workspaceId && location.path === request.input,
    )
  ) {
    const stored = yield* readCatalogue(writer.home);
    const collections = stored.value.collections.map((item) =>
      item.collection_id === collection.collection_id && item.upstream
        ? { ...item, upstream: { ...item.upstream, draft_home: request.draftHome } }
        : item,
    );
    yield* writer.saveCatalogue({ ...stored.value, collections }, stored.value, stored.revision);
    connected = true;
  }
  const previousImport = selectedSourceImport(state, collection.collection_id);
  const previous = state.collection_versions.find(
    (copy) => copy.collection_version_id === previousImport?.collection_version_id,
  );
  const prepared = yield* prepareAuthoredUpdate(
    writer.home,
    request,
    previous === undefined || previousImport === undefined
      ? undefined
      : { version: previous, importedAt: previousImport.imported_at },
    active,
  );
  if (prepared.root === undefined)
    return {
      status: "held" as const,
      installed: 0,
      installed_copies: [],
      issues: prepared.issues,
      context: yield* readAuthoredInstallation(state, collection.collection_id, lookup),
    };
  const { hash, importedAt } = prepared;
  if (hash !== previous?.hash) {
    yield* importAuthoredCollection(
      {
        root: prepared.root,
        input: request.input,
        source: { type: "local", path: request.input },
        sourceIdentity: collection.upstream.source_identity,
        label: collection.label,
        importedAt,
      },
      connected,
    );
  } else if (
    connected &&
    previousImport &&
    !state.local_draft_imports?.includes(previousImport.import_id)
  ) {
    const stored = yield* readCatalogue(writer.home);
    yield* writer.saveCatalogue(
      stored.value,
      stored.value,
      stored.revision,
      previousImport.import_id,
    );
  }
  const current = yield* loadLibrary(writer.home);
  const issues = [...prepared.issues];
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
          issues.push({ _tag: "UninstallBlocked", skill: skill.name, failure: error });
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
          issues.push({
            _tag: "CopyFailed",
            skill: skill.name,
            path: copy.path,
            failure: copy.cause,
          });
        if (copy._tag === "Conflicted" || copy._tag === "Pending")
          issues.push({
            _tag: copy._tag === "Conflicted" ? "CopyConflicted" : "CopyPending",
            skill: skill.name,
            path: copy.copy.path,
          });
      }
    } else
      issues.push({
        _tag: "InstallationFailed",
        skill: skill.name,
        paths: result.failedPaths ?? [],
        failure: result.cause,
      });
  }
  return {
    status: hash === previous?.hash ? ("unchanged" as const) : ("updated" as const),
    installed: installedCopies.length,
    installed_copies: installedCopies,
    issues,
    context: yield* readAuthoredInstallation(current, collection.collection_id, lookup),
  };
});

/** A preview cannot name a future Collection Version: changed members have not been saved as
 * Author revisions yet. The private preview provenance is never imported or installed. */
export const inspectAuthoredSkills = Effect.fn("Library.inspectAuthoredSkills")(function* (
  home: string,
  state: LibraryState,
  sourceImport: Import,
  workspace: { readonly workspaceId: string; readonly path: string },
  previous: CollectionVersion,
  active: readonly InstallDestination[],
) {
  const { tree, removal } = yield* inspectAuthorWorkspace(
    workspace.path,
    home,
    workspace.workspaceId,
  );
  const prepared = yield* prepareAuthoredUpdate(
    home,
    {
      workspaceId: workspace.workspaceId,
      input: workspace.path,
      tree,
      revisionId: "preview",
      savedAt: new Date(0).toISOString(),
      removal,
    },
    { version: previous, importedAt: sourceImport.imported_at },
    active,
  );
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
      issues: prepared.issues,
    };
  const descriptor = yield* readSkitDescriptor(prepared.root);
  const selectedRoot = prepared.root;
  return {
    kind: "authored" as const,
    snapshot_digest: prepared.hash,
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
    issues: prepared.issues,
  };
}, Effect.scoped);
