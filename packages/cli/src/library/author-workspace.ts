import {
  AUTHOR_WORKSPACE_METADATA_FILE,
  COLLECTION_CONTROL_DIRECTORY,
  LibraryStore,
  RetainedContentInvalid,
  initSkitEffect,
  validateSkitDirectoryEffect,
  retainAuthoredCollectionUnderLockEffect,
  writeJsonAtomicEffect,
  writeJsonExclusiveEffect,
  withLibraryWriter,
  type LibraryState,
  type Collection,
} from "@smolai/skit-core";
import { randomUUID } from "node:crypto";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { dirname, join, resolve } from "node:path";
import {
  AuthorWorkspaceMetadataInvalid,
  AuthorWorkspaceAlreadyRegistered,
  DirectoryAlreadyRetained,
} from "./failures.js";

const AUTHOR_WORKSPACE_SCHEMA = "skit.author-workspace.v1" as const;

interface AuthorWorkspaceMetadata {
  readonly schema: typeof AUTHOR_WORKSPACE_SCHEMA;
  readonly workspace_id: string;
  readonly registration?: "registered" | "removed";
}

const AuthorWorkspaceDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal(AUTHOR_WORKSPACE_SCHEMA),
    workspace_id: Schema.String.check(Schema.isPattern(/^workspace_[a-f0-9]{32}$/u)),
    registration: Schema.optionalKey(Schema.Literals(["registered", "removed"])),
  }),
);

const metadataPath = (root: string) =>
  join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);

const readAuthorWorkspaceEffect = Effect.fn("Library.readAuthorWorkspace")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = metadataPath(root);
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return undefined;
  const value = yield* Schema.decodeUnknownEffect(AuthorWorkspaceDocument, {
    onExcessProperty: "error",
  })(text).pipe(Effect.mapError(() => new AuthorWorkspaceMetadataInvalid({ path })));
  return {
    schema: value.schema,
    workspace_id: value.workspace_id,
    registration:
      "registration" in value && value.registration === "removed"
        ? "removed"
        : "registration" in value && value.registration === "registered"
          ? "registered"
          : undefined,
  } satisfies AuthorWorkspaceMetadata;
});

const writeAuthorWorkspaceEffect = Effect.fn("Library.writeAuthorWorkspace")(function* (
  root: string,
  metadata: AuthorWorkspaceMetadata,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(metadataPath(root), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
});

/** Library storage comes from LibraryStore; these are workspace lifecycle choices only. */
export interface AuthorWorkspaceOptions {
  readonly register?: boolean;
  readonly scaffold?: boolean;
  readonly workspaceId?: () => string;
}

const planWorkspaceEffect = Effect.fn("Author.planWorkspace")(function* (
  root: string,
  state: LibraryState,
  options: AuthorWorkspaceOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* readAuthorWorkspaceEffect(root);
  const physical = (yield* fs.exists(root)) ? yield* fs.realPath(root) : root;
  const acquisitionsFor = (collection: Collection) =>
    state.acquisitions.filter(
      (acquisition) => acquisition.collection_id === collection.collection_id,
    );
  const sameRoot: Collection[] = [];
  for (const collection of state.collections) {
    const inputs = acquisitionsFor(collection).map((acquisition) => acquisition.input.value);
    for (const input of inputs)
      if ((yield* fs.exists(input)) && (yield* fs.realPath(input)) === physical) {
        sameRoot.push(collection);
        break;
      }
  }
  const retained = sameRoot.find(
    (collection) => collection.upstream?.source_identity.kind === "authored-workspace",
  );
  const expectedWorkspaceId = workspace
    ? workspace.workspace_id
    : retained?.upstream?.source_identity.kind === "authored-workspace"
      ? retained.upstream.source_identity.workspace_id
      : undefined;
  const conflict = sameRoot.find(
    (collection) =>
      collection.upstream?.source_identity.kind !== "authored-workspace" ||
      collection.upstream.source_identity.workspace_id !== expectedWorkspaceId,
  );
  if (conflict)
    return yield* new DirectoryAlreadyRetained({
      collectionId: conflict.collection_id,
    });
  const planned: AuthorWorkspaceMetadata = workspace ?? {
    schema: "skit.author-workspace.v1",
    workspace_id:
      retained?.upstream?.source_identity.kind === "authored-workspace"
        ? retained.upstream.source_identity.workspace_id
        : (options.workspaceId?.() ?? `workspace_${randomUUID().replaceAll("-", "")}`),
  };
  const existing = state.collections.find(
    (collection) =>
      collection.upstream?.source_identity.kind === "authored-workspace" &&
      collection.upstream.source_identity.workspace_id === planned.workspace_id,
  );
  const existingInput =
    existing === undefined ? undefined : acquisitionsFor(existing)[0]?.input.value;
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

const registerOwnedWorkspaceEffect = Effect.fn("Author.registerOwnedWorkspace")(function* (
  root: string,
  plan: Effect.Success<ReturnType<typeof planWorkspaceEffect>>,
  register: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const validated = yield* validateSkitDirectoryEffect(root, "source", {
    assessmentContext: "retain",
  });
  if (plan.workspace.registration === "removed" && !register && !plan.existing) return undefined;
  const path = metadataPath(root);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  if (plan.missing) yield* writeJsonExclusiveEffect(path, plan.workspace);
  yield* fs
    .writeFileString(join(root, COLLECTION_CONTROL_DIRECTORY, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    })
    .pipe(
      Effect.uninterruptible,
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
      ),
    );
  const collection = yield* retainAuthoredCollectionUnderLockEffect({
    root,
    source: { type: "local", path: root },
    sourceIdentity: {
      kind: "authored-workspace",
      workspace_id: plan.workspace.workspace_id,
    },
    label: validated.identity.slug,
    input: root,
    retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
  });
  if (validated.descriptor.skills.length === 0)
    return yield* new RetainedContentInvalid({ diagnostics: ["retained Skills are missing"] });
  yield* writeJsonAtomicEffect(path, { ...plan.workspace, registration: "registered" });
  return collection;
});

export const ensureAuthorWorkspaceRegisteredEffect = Effect.fn("Author.ensureWorkspace")(function* (
  input: string,
  options: AuthorWorkspaceOptions = {},
) {
  const root = resolve(input);
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const plan = yield* planWorkspaceEffect(root, state, options);
  const initialized = options.scaffold ? yield* initSkitEffect(root) : undefined;
  const entry = yield* registerOwnedWorkspaceEffect(root, plan, options.register ?? false);
  return { initialized, entry };
}, withLibraryWriter);

/** Mark only the workspace that still carries the removed Collection's identity. */
export const markAuthorWorkspaceRemovedEffect = Effect.fn("Author.markWorkspaceRemoved")(function* (
  state: LibraryState,
  collectionId: string,
) {
  const collection = state.collections.find((item) => item.collection_id === collectionId);
  if (collection?.upstream?.source_identity.kind !== "authored-workspace") return;
  const path = state.acquisitions.find(
    (acquisition) =>
      acquisition.collection_id === collection.collection_id &&
      acquisition.source_identity.kind === "authored-workspace",
  )?.input.value;
  if (path === undefined) return;
  const workspace = yield* readAuthorWorkspaceEffect(path);
  if (workspace?.workspace_id === collection.upstream.source_identity.workspace_id)
    yield* writeAuthorWorkspaceEffect(path, { ...workspace, registration: "removed" });
}, withLibraryWriter);
