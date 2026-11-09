import { AuthorWorkspaceAlreadyRegistered, DirectoryAlreadyInLibrary } from "./failures.js";
import { ImportContentInvalid } from "../library/index.js";
import { initSkit as scaffoldSkit } from "./scaffold.js";
import { validateSkitDirectory } from "../artifact/skit.js";
import * as Library from "../library/index.js";

import {
  AuthorWorkspace,
  type Identity,
  type WorkspaceId,
  type WorkspaceRoot,
} from "./workspace.js";

import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { workspaceIdFromClaims } from "./library-claims.js";
import { AuthorHistory, authorHistoryStoreError } from "./history.js";

/**
 * What the Library already says about this folder: no other Collection may claim it, and a
 * Collection imported from it keeps its workspace id when workspace.json has gone (A3).
 */
const checkLibraryClaims = Effect.fn("Author.checkLibraryClaims")(function* (
  home: string,
  root: WorkspaceRoot,
  identity: Option.Option<Identity>,
) {
  const claims = yield* (yield* Library.Service).workspaceClaims(root);
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
    adopt: Option.isSome(identity) ? Option.none<WorkspaceId>() : workspaceIdFromClaims(sameRoot),
    existing,
  };
});

/**
 * `author init`: scaffold the folder and import it into the Library, under the workspace lease
 * (A11). A workspace whose Collection was removed is imported again, keeping its identity. If the
 * Library refuses the import, the identity stays and a retry reuses it (A3).
 */
export const initializeAuthorWorkspace = Effect.fn("Author.initialize")(function* (
  input: string,
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
  const workspace = Option.isNone(identity) ? yield* lease.register(claims.adopt) : identity.value;
  const history = yield* AuthorHistory;
  const saved = yield* history.refresh(root);
  const tree = yield* history.engineStore
    .tree(saved.treeHash)
    .pipe(Effect.mapError(authorHistoryStoreError));
  // Explicit registration/import accepts this inventory; later automatic passes cannot do so.
  yield* history.inventory.refresh(lease, workspace.workspaceId, tree, true);
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
