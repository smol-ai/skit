import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Clock, Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  LibraryStore,
  RetainedContentInvalid,
  initSkitEffect,
  validateSkitDirectoryEffect,
  retainAuthoredCollectionUnderLockEffect,
  writeJsonAtomicEffect,
  writeJsonExclusiveEffect,
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
  type LibraryState,
  type Collection,
} from "@smolai/skit-core";
import {
  AuthorWorkspaceAlreadyRegistered,
  DirectoryAlreadyRetained,
} from "../../library/failures.js";
import type { ProjectionOptions } from "../../workflows/library/projection-options.js";
import { handleCommand } from "../../application.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { result } from "../../handlers/contracts.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  readAuthorWorkspaceEffect,
  type AuthorWorkspaceMetadata,
} from "../../library/author-workspace.js";

export interface AuthorInitializationOptions extends ProjectionOptions {
  libraryHome: string;
  workspaceId?: () => string;
}
const planWorkspaceEffect = Effect.fn("Author.planWorkspace")(function* (
  root: string,
  state: LibraryState,
  options: AuthorInitializationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspace = yield* readAuthorWorkspaceEffect(root);
  const physical = (yield* fs.exists(root)) ? yield* fs.realPath(root) : root;
  const acquisitionsFor = (collection: Collection) => {
    const acquisitionIds = new Set(
      state.skills
        .filter((skill) => skill.collection_id === collection.collection_id)
        .flatMap((skill) =>
          skill.versions.flatMap((version) =>
            version.origins.map((origin) => origin.acquisition_id),
          ),
        ),
    );
    return state.acquisitions.filter((acquisition) =>
      acquisitionIds.has(acquisition.acquisition_id),
    );
  };
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
  const expectedRef = workspace
    ? `authored:${workspace.workspace_id}`
    : retained?.upstream?.source_identity.kind === "authored-workspace"
      ? `authored:${retained.upstream.source_identity.workspace_id}`
      : undefined;
  const conflict = sameRoot.find(
    (collection) =>
      collection.upstream?.source_identity.kind !== "authored-workspace" ||
      `authored:${collection.upstream.source_identity.workspace_id}` !== expectedRef,
  );
  if (conflict)
    return yield* new DirectoryAlreadyRetained({
      collectionRef: conflict.collection_id,
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
      collectionRef: existing?.collection_id ?? `authored:${planned.workspace_id}`,
      at: existingInput,
    });
  return { workspace: planned, missing: workspace === undefined, existing };
});

const registerOwnedWorkspaceEffect = Effect.fn("Author.registerOwnedWorkspace")(function* (
  root: string,
  options: AuthorInitializationOptions,
  plan: Effect.Success<ReturnType<typeof planWorkspaceEffect>>,
  register: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const validated = yield* validateSkitDirectoryEffect(root, "source", {
    assessmentContext: "retain",
  });
  if (plan.workspace.registration === "removed" && !register && !plan.existing) return undefined;
  const metadataPath = join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE);
  yield* fs.makeDirectory(dirname(metadataPath), { recursive: true, mode: 0o700 });
  if (plan.missing) yield* writeJsonExclusiveEffect(metadataPath, plan.workspace);
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
    identity: {
      profile: "authored-workspace",
      version: 1,
      workspaceId: plan.workspace.workspace_id,
      slug: validated.identity.slug,
    },
    input: root,
    retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
  });
  if (validated.descriptor.skills.length === 0)
    return yield* new RetainedContentInvalid({ diagnostics: ["retained Skills are missing"] });
  yield* writeJsonAtomicEffect(metadataPath, { ...plan.workspace, registration: "registered" });
  return collection;
});

export const ensureAuthoredWorkspaceEffect = Effect.fn("Author.ensureWorkspace")(function* (
  input: string,
  options: AuthorInitializationOptions,
  register = false,
  scaffold = false,
) {
  const root = resolve(input);
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const plan = yield* planWorkspaceEffect(root, state, options);
  const initialized = scaffold ? yield* initSkitEffect(root) : undefined;
  const entry = yield* registerOwnedWorkspaceEffect(root, options, plan, register);
  return { initialized, entry };
});

export const authorInitCommand = Effect.fn("CLI.authorInit")(function* (
  input: string,
  options: AuthorInitializationOptions,
  register: boolean,
) {
  const result = yield* ensureAuthoredWorkspaceEffect(input, options, register, true);
  const initialized = yield* Effect.fromNullishOr(result.initialized).pipe(Effect.orDie);
  return { initialized, entry: result.entry };
});

const path = Argument.string("path").pipe(Argument.optional);
const register = Flag.boolean("register").pipe(
  Flag.withDescription("Re-register a previously removed Author Workspace Library Entry."),
  Flag.withDefault(false),
);

export const authorInitCliCommand = Command.make(
  "init",
  { path, register, ...localFlags },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const configuration = yield* libraryCommandConfiguration(input);
        const { initialized: value, entry } = yield* authorInitCommand(
          Option.getOrElse(input.path, () => "."),
          {
            ...configuration.inventory,
            libraryHome: configuration.libraryHome,
            statePath: join(configuration.libraryHome, "state.json"),
            variantsPath: join(configuration.libraryHome, "variants"),
          },
          input.register,
        );
        const output = {
          ...value,
          library_registration: entry ? ("registered" as const) : ("removed" as const),
        };
        yield* renderer.result(result("init", outputContracts.init, output));
      }),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Initialize SKIT authoring in a new or existing Skill Collection."),
  Command.withExamples([
    { command: "skit author init" },
    { command: "skit author init ./my-tools" },
    { command: "skit author init --register" },
  ]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.init],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
