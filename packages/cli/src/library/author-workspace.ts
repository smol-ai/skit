import { localLibrary } from "../library-application/library-owner.js";
import {
  COLLECTION_CONTROL_DIRECTORY,
  LibraryStore,
  ImportContentInvalid,
  initSkit,
  validateSkitDirectory,
  writeJsonAtomic,
  writeJsonExclusive,
  withLibraryWriter,
  syncPaths,
  type LibraryState,
  type Collection,
} from "@smolai/skit-core";
import { randomUUID } from "node:crypto";
import { Clock, Effect, FileSystem } from "effect";
import { dirname, join, resolve } from "node:path";
import { AuthorWorkspaceAlreadyRegistered, DirectoryAlreadyInLibrary } from "./failures.js";

import {
  authorWorkspaceMetadataPath,
  loadAuthorWorkspaceMetadata,
  type AuthorWorkspaceMetadata,
} from "./author-workspace-metadata.js";

/** Flush the metadata file and the directories that name it. */
const flushWorkspaceMetadata = (root: string) =>
  syncPaths([authorWorkspaceMetadataPath(root), dirname(authorWorkspaceMetadataPath(root)), root]);

/** Publish lifecycle changes atomically and durably before reporting registration. */
export const writeAuthorWorkspace = Effect.fn("Library.writeAuthorWorkspace")(function* (
  root: string,
  metadata: AuthorWorkspaceMetadata,
) {
  yield* writeJsonAtomic(authorWorkspaceMetadataPath(root), metadata);
  yield* flushWorkspaceMetadata(root);
});

/** Library storage comes from LibraryStore; these are workspace lifecycle choices only. */
export interface AuthorWorkspaceOptions {
  readonly register?: boolean;
  readonly scaffold?: boolean;
  readonly workspaceId?: () => string;
}

export const planAuthorWorkspace = Effect.fn("Author.planAuthorWorkspace")(function* (
  root: string,
  state: LibraryState,
  options: AuthorWorkspaceOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* loadAuthorWorkspaceMetadata(root);
  const physical = (yield* fs.exists(root)) ? yield* fs.realPath(root) : root;
  const importsFor = (collection: Collection) =>
    state.imports.filter((sourceImport) => sourceImport.collection_id === collection.collection_id);
  const sameRoot: Collection[] = [];
  for (const collection of state.collections) {
    const inputs = importsFor(collection).map((sourceImport) => sourceImport.input.value);
    for (const input of inputs)
      if ((yield* fs.exists(input)) && (yield* fs.realPath(input)) === physical) {
        sameRoot.push(collection);
        break;
      }
  }
  const imported = sameRoot.find(
    (collection) => collection.upstream?.source_identity.kind === "authored-workspace",
  );
  const expectedWorkspaceId = workspace
    ? workspace.workspace_id
    : imported?.upstream?.source_identity.kind === "authored-workspace"
      ? imported.upstream.source_identity.workspace_id
      : undefined;
  const conflict = sameRoot.find(
    (collection) =>
      collection.upstream?.source_identity.kind !== "authored-workspace" ||
      collection.upstream.source_identity.workspace_id !== expectedWorkspaceId,
  );
  if (conflict)
    return yield* new DirectoryAlreadyInLibrary({
      collectionId: conflict.collection_id,
    });
  const planned: AuthorWorkspaceMetadata = workspace ?? {
    schema: "skit.author-workspace.v1",
    workspace_id:
      imported?.upstream?.source_identity.kind === "authored-workspace"
        ? imported.upstream.source_identity.workspace_id
        : (options.workspaceId?.() ?? `workspace_${randomUUID().replaceAll("-", "")}`),
  };
  const existing = state.collections.find(
    (collection) =>
      collection.upstream?.source_identity.kind === "authored-workspace" &&
      collection.upstream.source_identity.workspace_id === planned.workspace_id,
  );
  const existingInput = existing === undefined ? undefined : importsFor(existing)[0]?.input.value;
  if (
    existingInput !== undefined &&
    (yield* fs.exists(existingInput)) &&
    (yield* fs.realPath(existingInput)) !== physical
  )
    return yield* new AuthorWorkspaceAlreadyRegistered({
      workspaceId: planned.workspace_id,
      at: existingInput,
    });
  return { workspace: planned, missing: workspace === undefined, existing };
});

/** Metadata publication is independent of artifact validity; no authored config is written. */
export const prepareAuthorWorkspaceMetadata = Effect.fn("Author.prepareAuthorWorkspaceMetadata")(
  function* (root: string, plan: Effect.Success<ReturnType<typeof planAuthorWorkspace>>) {
    const fs = yield* FileSystem.FileSystem;
    const path = authorWorkspaceMetadataPath(root);
    yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
    if (plan.missing) yield* writeJsonExclusive(path, plan.workspace);
    yield* fs
      .writeFileString(join(root, COLLECTION_CONTROL_DIRECTORY, ".gitignore"), "*\n", {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.uninterruptible,
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void),
      );
    yield* syncPaths([join(root, COLLECTION_CONTROL_DIRECTORY, ".gitignore")]);
    yield* flushWorkspaceMetadata(root);
  },
);

const registerOwnedWorkspace = Effect.fn("Author.registerOwnedWorkspace")(function* (
  root: string,
  plan: Effect.Success<ReturnType<typeof planAuthorWorkspace>>,
  register: boolean,
) {
  const validated = yield* validateSkitDirectory(root, "source", {
    assessmentContext: "import",
  });
  if (plan.workspace.registration === "removed" && !register && !plan.existing) return undefined;
  yield* prepareAuthorWorkspaceMetadata(root, plan);
  const collection = yield* (yield* localLibrary).import.authored({
    root,
    source: { type: "local", path: root },
    sourceIdentity: {
      kind: "authored-workspace",
      workspace_id: plan.workspace.workspace_id,
    },
    label: validated.identity.slug,
    input: root,
    importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
  });
  if (validated.descriptor.skills.length === 0)
    return yield* new ImportContentInvalid({ diagnostics: ["retained Skills are missing"] });
  yield* writeAuthorWorkspace(root, { ...plan.workspace, registration: "registered" });
  return collection;
});

export const ensureAuthorWorkspaceRegistered = Effect.fn("Author.ensureWorkspace")(function* (
  input: string,
  options: AuthorWorkspaceOptions = {},
) {
  const root = resolve(input);
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const plan = yield* planAuthorWorkspace(root, state, options);
  const initialized = options.scaffold ? yield* initSkit(root) : undefined;
  const entry = yield* registerOwnedWorkspace(root, plan, options.register ?? false);
  return { initialized, entry };
}, withLibraryWriter);

/** Mark only the workspace that still carries the removed Collection's identity. */
export const markAuthorWorkspaceRemoved = Effect.fn("Author.markWorkspaceRemoved")(function* (
  state: LibraryState,
  collectionId: string,
) {
  const collection = state.collections.find((item) => item.collection_id === collectionId);
  if (collection?.upstream?.source_identity.kind !== "authored-workspace") return;
  const path = state.imports.find(
    (sourceImport) =>
      sourceImport.collection_id === collection.collection_id &&
      sourceImport.source_identity.kind === "authored-workspace",
  )?.input.value;
  if (path === undefined) return;
  const workspace = yield* loadAuthorWorkspaceMetadata(path);
  if (workspace?.workspace_id === collection.upstream.source_identity.workspace_id)
    yield* writeAuthorWorkspace(path, { ...workspace, registration: "removed" });
}, withLibraryWriter);
