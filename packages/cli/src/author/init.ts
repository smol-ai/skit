import {
  skitConfigurationLayer,
  ImportContentInvalid,
  initSkit,
  validateSkitDirectory,
  Library,
} from "@smolai/skit-core";

import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleLibraryCommand } from "../commands/handler.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { localFlags } from "../commands/parameters.js";
import { result } from "../commands/result.js";
import { Renderer } from "../terminal/renderer.js";
import {
  AuthorWorkspaceAlreadyRegistered,
  AuthorWorkspace,
  type Identity,
  type WorkspaceId,
  type WorkspaceRoot,
} from "@smolai/skit-core/author";
import {
  AuthorWorkspaceRemovalUnfinished,
  DirectoryAlreadyInLibrary,
} from "../library/failures.js";

import { adoptFrom, authoredId, collectionsAt } from "./library-claims.js";

/**
 * What the Library already says about this folder: no other Collection may claim it, and a
 * Collection imported from it keeps its workspace id when workspace.json has gone (A3).
 */
const checkLibraryClaims = Effect.fn("Author.checkLibraryClaims")(function* (
  root: WorkspaceRoot,
  snapshot: Library.Snapshot,
  identity: Option.Option<Identity>,
) {
  if (snapshot._tag === "Absent") return { adopt: Option.none<WorkspaceId>(), existing: undefined };
  const { state } = snapshot;
  const fs = yield* FileSystem.FileSystem;
  const sameRoot = yield* collectionsAt(root, state);
  const imported = sameRoot.find((collection) => authoredId(collection) !== undefined);
  const expected = Option.isSome(identity) ? identity.value.workspaceId : authoredId(imported);
  const conflict = sameRoot.find(
    (collection) => authoredId(collection) === undefined || authoredId(collection) !== expected,
  );
  if (conflict)
    return yield* new DirectoryAlreadyInLibrary({ collectionId: conflict.collection_id });
  const existing =
    expected === undefined
      ? undefined
      : state.collections.find((collection) => authoredId(collection) === expected);
  const existingInput =
    existing === undefined
      ? undefined
      : state.imports.find((sourceImport) => sourceImport.collection_id === existing.collection_id)
          ?.input.value;
  if (
    expected !== undefined &&
    existingInput !== undefined &&
    (yield* fs.exists(existingInput)) &&
    (yield* fs.realPath(existingInput)) !== root
  )
    return yield* new AuthorWorkspaceAlreadyRegistered({
      workspaceId: expected,
      at: existingInput,
    });
  return {
    adopt: Option.isSome(identity) ? Option.none<WorkspaceId>() : adoptFrom(sameRoot),
    existing,
  };
});

/**
 * `author init`: scaffold the folder and register it for installation, under the workspace lease
 * (A11). A removed workspace stays opted out unless `register` opts it back in. If the Library
 * then refuses the import, the workspace stays Registered and a retry reuses its identity (A3).
 */
export const authorInitCommand = Effect.fn("CLI.authorInit")(function* (
  input: string,
  register: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* AuthorWorkspace;
  const folder = path.resolve(input);
  // `author init` may start a new Collection: the folder itself is created first.
  yield* fs.makeDirectory(folder, { recursive: true });
  const root = yield* workspaces.resolveRoot(folder);
  const lease = yield* workspaces.acquire(root);
  const library = yield* Library.Service;
  const identity = yield* workspaces.readIdentity(root);
  const claims = yield* checkLibraryClaims(root, yield* library.read, identity);
  const initialized = yield* initSkit(folder);
  const validated = yield* validateSkitDirectory(folder, "source", {
    assessmentContext: "import",
  });
  const registered = Option.isNone(identity)
    ? yield* lease.register({ from: identity, to: "Registered", adopt: claims.adopt })
    : identity.value.registration === "IdentityOnly"
      ? yield* lease.register({
          from: { ...identity.value, registration: "IdentityOnly" },
          to: "Registered",
        })
      : identity.value;
  // A removal whose Library half finished is completed here; one still in the Library is not.
  const settled =
    registered.registration === "Removing"
      ? claims.existing === undefined
        ? yield* lease.register({
            from: { ...registered, registration: "Removing" },
            to: "Removed",
          })
        : yield* new AuthorWorkspaceRemovalUnfinished({
            collectionId: claims.existing.collection_id,
          })
      : registered;
  if (settled.registration === "Removed" && !register) return { initialized, entry: undefined };
  const workspace =
    settled.registration === "Removed"
      ? yield* lease.register({
          from: { ...settled, registration: "Removed" },
          to: "Registered",
          optIn: true,
        })
      : settled;
  const entry = yield* library.import.authored({
    root: folder,
    source: { type: "local", path: folder },
    sourceIdentity: { kind: "authored-workspace", workspace_id: workspace.workspaceId },
    label: validated.identity.slug,
    input: folder,
    importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
  });
  if (validated.descriptor.skills.length === 0)
    return yield* new ImportContentInvalid({ diagnostics: ["retained Skills are missing"] });
  return { initialized, entry };
  // The lease ends with the command.
}, Effect.scoped);

const path = Argument.String("path").pipe(Argument.optional);
const register = Flag.Boolean("register").pipe(
  Flag.withDescription("Re-register a previously removed Author Workspace Library Entry."),
  Flag.withDefault(false),
);

export const authorInitCliCommand = Command.make(
  "init",
  { path, register, ...localFlags },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const { initialized: value, entry } = yield* authorInitCommand(
          Option.getOrElse(input.path, () => "."),
          input.register,
        );
        const output = {
          ...value,
          library_registration: entry ? ("registered" as const) : ("removed" as const),
        };
        yield* renderer.result(result("init", output));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
