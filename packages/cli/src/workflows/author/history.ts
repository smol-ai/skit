import { Clock, Effect, FileSystem, Path, Result, Schema } from "effect";
import { History, LinkStat, MachineSettings, syncPaths, walkAuthorTree } from "@smolai/skit-core";
import { configurationForHome } from "../../configuration/skit-configuration.js";
import { readAuthorWorkspace } from "../../library/author-workspace-metadata.js";
import { LocalFilesChangedDuringSync } from "../../registry/failures.js";
import { AuthorHistoryInvalid } from "./history-contracts.js";
import { readAuthorHistoryEvents, writeAuthorHistoryEvent } from "./history-journal.js";
import { withDeviceStore } from "./device-store.js";
export { AuthorHistoryInvalid, AuthorHistoryEvent } from "./history-contracts.js";

/** Where this device keeps its author history: `<skitHome>/history`. */
export const historyDirectory = Effect.fn("Author.historyDirectory")(function* (home?: string) {
  const path = yield* Path.Path;
  return path.join((yield* configurationForHome(home)).skitHome, "history");
});

/** Read one stored tree by its hash. */
export const loadAuthorTree = Effect.fn("Author.loadTree")(function* (hash: string, home?: string) {
  const checked = yield* Schema.decodeUnknownEffect(History.TreeHash)(hash);
  const directory = yield* historyDirectory(home);
  return yield* Effect.flatMap(History.Store, (store) => store.tree(checked)).pipe(
    withDeviceStore(directory),
  );
});

/** This workspace's revisions in the order they were saved, without reading their trees. */
export const loadAuthorHistory = Effect.fn("Author.loadHistory")(function* (
  input: string,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(input));
  const workspace = yield* readAuthorWorkspace(root).pipe(
    Effect.catchTag("AuthorWorkspaceMetadataInvalid", () => Effect.succeed(undefined)),
  );
  const directory = yield* historyDirectory(home);
  const events = yield* readAuthorHistoryEvents(directory, root, workspace?.workspace_id);
  return yield* Effect.gen(function* () {
    const store = yield* History.Store;
    return yield* Effect.forEach(events, (event) =>
      Effect.gen(function* () {
        const revision = yield* store.revision(event.revision);
        if (!(yield* store.hasTree(revision.tree)))
          return yield* new AuthorHistoryInvalid({
            path: path.join(directory, "journal.sqlite"),
            reason: "journal content is missing",
          });
        return { sequence: event.sequence, id: event.revision, revision };
      }),
    );
  }).pipe(withDeviceStore(directory));
});

/** Every tree stored on this device; reads the trees themselves, so it proves what is recoverable. */
export const loadStoredTrees = Effect.fn("Author.loadStoredTrees")(function* (home?: string) {
  const directory = yield* historyDirectory(home);
  return yield* Effect.gen(function* () {
    const store = yield* History.Store;
    return yield* Effect.forEach(yield* store.trees, (hash) =>
      Effect.map(store.tree(hash), (tree) => ({ hash, tree })),
    );
  }).pipe(withDeviceStore(directory));
});

/**
 * Save a stable, unvalidated tree before sync can change it. Originals, executable modes,
 * directories and symlinks use the verbatim tree format. Root Git/control exclusions and
 * .gitignore remain in effect. An unchanged scan records nothing and returns the latest
 * revision; returning to older content records a new revision that shares the older tree.
 */
export const saveAuthorWorkspace = Effect.fn("Author.saveWorkspace")(function* (
  input: string,
  home?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const requestedRoot = path.resolve(input);
  const root = yield* fs.realPath(requestedRoot);
  const directory = yield* historyDirectory(home);
  const skitHome = path.dirname(directory);
  const insideRoot = (candidatePath: string) =>
    [root, requestedRoot].some(
      (candidate) =>
        candidatePath === candidate || candidatePath.startsWith(`${candidate}${path.sep}`),
    );
  if (insideRoot(skitHome))
    return yield* new AuthorHistoryInvalid({
      path: directory,
      reason: "history cannot be inside its workspace",
    });
  for (const folder of [
    skitHome,
    directory,
    path.join(directory, "trees"),
    path.join(directory, "revisions"),
  ]) {
    yield* fs.makeDirectory(folder, { recursive: true, mode: 0o700 });
    if (insideRoot(yield* fs.realPath(folder)))
      return yield* new AuthorHistoryInvalid({
        path: directory,
        reason: "history resolves inside its workspace",
      });
  }
  const links = yield* LinkStat;
  const journalPath = path.join(directory, "journal.sqlite");
  const journalFile = yield* links
    .lstat(journalPath)
    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
  if (journalFile?.type === "SymbolicLink")
    return yield* new AuthorHistoryInvalid({
      path: journalPath,
      reason: "journal cannot be a symbolic link",
    });
  // Broken device-local metadata must not prevent backing up the authored files. This is
  // path-provenance fallback only; it neither creates nor repairs a workspace identity.
  const workspace = yield* readAuthorWorkspace(root).pipe(
    Effect.catchTag("AuthorWorkspaceMetadataInvalid", () => Effect.succeed(undefined)),
  );
  // Machine identity may need the Library writer. Never acquire that writer while holding the
  // journal permit/transaction: promotion saves history under its Library writer, so the reverse
  // order would deadlock.
  const identity = yield* Effect.result(
    Effect.gen(function* () {
      const settings = yield* MachineSettings.read(skitHome);
      return settings.machineId ?? (yield* MachineSettings.ensureIdentity(skitHome));
    }),
  );

  const save = (latest: History.RevisionId | undefined) =>
    Effect.gen(function* () {
      const readStable = Effect.gen(function* () {
        const tree = yield* walkAuthorTree(root, "verbatim");
        const treeHash = yield* History.treeHash(tree);
        const again = yield* History.treeHash(yield* walkAuthorTree(root, "verbatim"));
        if (treeHash !== again) return yield* new LocalFilesChangedDuringSync();
        return { tree, treeHash };
      });
      const { tree, treeHash } = yield* readStable.pipe(
        Effect.retry({ times: 2, while: (error) => error._tag === "LocalFilesChangedDuringSync" }),
      );
      const store = yield* History.Store;
      const previous =
        latest === undefined ? undefined : { id: latest, revision: yield* store.revision(latest) };
      const unchanged = previous?.revision.tree === treeHash;
      if (unchanged || Result.isFailure(identity)) {
        // Verify the stored tree, and keep the bytes even when there is no device to record as.
        yield* store.putTree(tree);
        if (previous && unchanged) return { ...previous, tree, treeHash };
      }
      const recorded = yield* History.record(tree, previous ? [previous.id] : [], {
        device: yield* Effect.fromResult(identity),
        at: yield* Clock.currentTimeMillis,
      });
      return { ...recorded, tree, treeHash };
    }).pipe(withDeviceStore(directory));

  const saved = yield* writeAuthorHistoryEvent(directory, root, workspace?.workspace_id, save);
  // The SQL client has closed/checkpointed before acknowledgement; persist new directory entries.
  yield* syncPaths([directory, skitHome, path.dirname(skitHome)]);
  return {
    ...saved,
    root,
    ...(workspace ? { workspace_id: workspace.workspace_id } : {}),
  };
});
