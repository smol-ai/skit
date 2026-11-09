import { Effect, Layer, Result, Schedule } from "effect";
import { AuthorWorkspace, AuthorWorkspaceUnsafe, type WorkspaceLease } from "./workspace.js";
import { AuthorHistory, authorHistoryStoreError } from "./history.js";
import * as Library from "../library/library.js";
import { syncAuthorWorkspace } from "./sync.js";
import type { AuthorRegistry } from "./transport.js";
import { resolve } from "node:path";

export const authorWorkspaceLayer = AuthorWorkspace.layer;
export const authorLayer = (config: { readonly home: string }) =>
  AuthorHistory.layer(config).pipe(Layer.provideMerge(authorWorkspaceLayer));

export const readAuthorWorkspace = Effect.fn("Author.readWorkspace")(function* (input: string) {
  const workspace = yield* AuthorWorkspace;
  return yield* workspace.read(yield* workspace.resolveRoot(input));
});

/** Preserve an observation of the workspace without installing it or changing its connection. */
export const refreshAuthorWorkspace = Effect.fn("Author.refreshWorkspace")(function* (
  input: string,
) {
  const root = yield* (yield* AuthorWorkspace).resolveRoot(input);
  return yield* (yield* AuthorHistory).refresh(root);
});

/** One workspace lease orders saved inputs and installation against manual sync/edits. */
export const updateAuthoredSkills = Effect.fn("Author.updateSkills")(
  function* (
    input: string,
    heldLease?: WorkspaceLease,
    options: { readonly confirmRemovals?: boolean } = {},
  ) {
    const workspaces = yield* AuthorWorkspace;
    const root = yield* workspaces.resolveRoot(input);
    if (heldLease !== undefined && heldLease.root !== root)
      return yield* new AuthorWorkspaceUnsafe({
        path: root,
        reason: "the workspace lease belongs to a different root",
      });
    const lease = heldLease ?? (yield* workspaces.acquire(root));
    yield* lease.revision;
    const identity = yield* workspaces.readIdentity(root);
    if (identity._tag === "None")
      return {
        status: "unregistered" as const,
        installed: 0,
        installed_copies: [],
        messages: [] as string[],
        context: undefined,
      };
    const history = yield* AuthorHistory;
    const observe = Effect.gen(function* () {
      const saved = yield* history.refresh(root);
      const tree = yield* history.engineStore
        .tree(saved.treeHash)
        .pipe(Effect.mapError(authorHistoryStoreError));
      const removal = yield* history.inventory.refresh(lease, identity.value.workspaceId, tree);
      return { saved, tree, removal };
    });
    let observed = yield* observe;
    if (
      options.confirmRemovals &&
      observed.removal.status === "waiting" &&
      observed.removal.membershipReadable &&
      (observed.removal.heldFiles.length > 0 || observed.removal.heldMembers.length > 0)
    ) {
      // A foreground command must get both observations in one runtime. Only the workspace
      // lease spans this wait; Library has not opened its writer. Changed absences still hold.
      yield* Effect.sleep("10 seconds");
      observed = yield* observe;
    }
    const { saved, tree, removal } = observed;
    const library = yield* Library.Service;
    const updated = yield* library.updateAuthoredSkills({
      workspaceId: identity.value.workspaceId,
      input: root,
      tree,
      revisionId: saved.id,
      savedAt: new Date(saved.revision.author.at).toISOString(),
      removal,
    });
    return { ...updated, revision_id: saved.id };
  },
  Effect.scoped,
  (
    effect,
    input: string,
    _heldLease?: WorkspaceLease,
    _options?: { readonly confirmRemovals?: boolean },
  ) =>
    effect.pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          const history = yield* AuthorHistory;
          yield* history.inventory.reset(resolve(input));
        }),
      ),
    ),
);

/** Local installation and Registry backup are independent outcomes of one workspace operation.
 * Sync may advance removal authority or change local files even before failing. Always install
 * another stable observation before releasing the lease, independently of its network outcome. */
export const updateAuthorWorkspace = Effect.fn("Author.updateWorkspace")(function* <E, R, P>(
  input: string,
  options: { readonly home: string },
  registry: Pick<AuthorRegistry<E, R, P>, "origin" | "connect">,
) {
  const workspaces = yield* AuthorWorkspace;
  const root = yield* workspaces.resolveRoot(input);
  const lease = yield* workspaces.acquire(root).pipe(
    Effect.retry({
      while: (error) => error._tag === "AuthorWorkspaceBusy",
      schedule: Schedule.spaced("100 millis"),
      times: 400,
    }),
  );
  const installation = yield* updateAuthoredSkills(root, lease, { confirmRemovals: true }).pipe(
    Effect.result,
  );
  const workspace = yield* workspaces.read(root);
  if (workspace.connection._tag !== "Connected") return { installation, sync: undefined };
  const sync = yield* syncAuthorWorkspace(root, { ...options, apply: true }, registry, lease).pipe(
    Effect.timeout("30 seconds"),
    Effect.result,
  );
  const updated = yield* updateAuthoredSkills(root, lease, { confirmRemovals: true }).pipe(
    Effect.result,
  );
  if (installation._tag === "Success" && updated._tag === "Success") {
    const copies = [
      ...new Map(
        [...installation.success.installed_copies, ...updated.success.installed_copies].map(
          (copy) => [copy.path, copy],
        ),
      ).values(),
    ];
    return {
      installation: Result.succeed({
        ...updated.success,
        installed: copies.length,
        installed_copies: copies,
      }),
      sync,
    };
  }
  return { installation: updated, sync };
}, Effect.scoped);
