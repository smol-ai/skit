import {
  AuthorWorkspaceAlreadyRegistered,
  AuthorWorkspaceRemovalUnfinished,
  DirectoryAlreadyInLibrary,
} from "./failures.js";
import { ImportContentInvalid } from "../library/index.js";
import { initSkit as scaffoldSkit } from "./scaffold.js";
import { validateSkitDirectory } from "../artifact/skit.js";
import * as Library from "../library/index.js";
import { readLibraryWorkspaceClaims } from "../library/queries.js";

import {
  AuthorWorkspace,
  type Identity,
  type WorkspaceId,
  type WorkspaceRoot,
} from "./workspace.js";

import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { adoptFrom } from "./library-claims.js";

/**
 * What the Library already says about this folder: no other Collection may claim it, and a
 * Collection imported from it keeps its workspace id when workspace.json has gone (A3).
 */
const checkLibraryClaims = Effect.fn("Author.checkLibraryClaims")(function* (
  home: string,
  root: WorkspaceRoot,
  identity: Option.Option<Identity>,
) {
  const claims = yield* readLibraryWorkspaceClaims(home, root);
  const sameRoot = claims.atRoot;
  const imported = sameRoot.find((collection) => collection.workspaceId !== undefined);
  const expected = Option.isSome(identity) ? identity.value.workspaceId : imported?.workspaceId;
  const conflict = sameRoot.find(
    (collection) => collection.workspaceId === undefined || collection.workspaceId !== expected,
  );
  if (conflict)
    return yield* new DirectoryAlreadyInLibrary({ collectionId: conflict.collectionId });
  const existing = expected === undefined ? undefined : yield* claims.readRegistration(expected);
  if (
    expected !== undefined &&
    existing?.input !== undefined &&
    existing.root !== undefined &&
    existing.root !== root
  )
    return yield* new AuthorWorkspaceAlreadyRegistered({
      workspaceId: expected,
      at: existing.input,
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
export const initializeAuthorWorkspace = Effect.fn("Author.initialize")(function* (
  input: string,
  register: boolean,
  home: string,
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
  const claims = yield* checkLibraryClaims(home, root, identity);
  const initialized = yield* scaffoldSkit(folder);
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
            collectionId: claims.existing.collectionId,
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

/** Scaffold authored files under the same lease used by other built-in workspace edits. */
export const initSkit = Effect.fn("Author.initSkit")(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.resolve(input);
  yield* fs.makeDirectory(folder, { recursive: true });
  const workspaces = yield* AuthorWorkspace;
  yield* workspaces.acquire(yield* workspaces.resolveRoot(folder));
  return yield* scaffoldSkit(folder);
}, Effect.scoped);
