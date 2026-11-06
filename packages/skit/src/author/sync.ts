import { Effect, Option, Ref, Result, Schema } from "effect";
import { join } from "node:path";
import {
  AuthorWorkspace,
  AuthorSyncStateInvalid,
  AuthorWorkspaceConflict,
  type Connecting,
} from "./workspace.js";
import { AuthorHistory, authorHistoryStoreError } from "./history.js";
import {
  LocalFilesChangedDuringSync,
  AuthorRemoteAlreadyExists,
  VisibilityNotAccepted,
} from "./failures.js";
import { scanAuthorSyncTree } from "./local-tree.js";
import type { AuthorVisibility, AuthorRemoteHome } from "./remote.js";
import type { AuthorSyncResult } from "./sync-result.js";
import { authorDecider, authorTree } from "./sync-policy.js";
import { adoptFrom } from "./library-claims.js";
import { readLibraryWorkspaceClaims } from "../library/queries.js";
import { conflictKind } from "./merge/files.js";
import * as History from "../history/history.js";
import * as Sync from "../sync/sync.js";
import { MissingRequirement } from "../shared/input-failures.js";
import { parseAuthorDestination, skitLocator } from "./destination.js";
import { backupAuthorHistory } from "./backup.js";
import type { AuthorRegistry } from "./transport.js";

/** A first sync names its destination and visibility; it is persisted only once connecting. */
type Destination =
  | Connecting
  | {
      readonly _tag: "NewRemote";
      readonly remote: AuthorRemoteHome;
      readonly visibility: AuthorVisibility;
    }
  | { readonly _tag: "ConnectedRemote"; readonly remote: AuthorRemoteHome };

/**
 * `skit author sync` (architecture/author.ts "Commands"). Applying holds the workspace lease for
 * the whole command; a preview takes none and creates nothing but history backups.
 */
export const syncAuthorWorkspace = Effect.fn("Sync.skit")(function* <E, R, P>(
  rootInput: string,
  options: {
    readonly apply: boolean;
    readonly allowLargeDeletion?: boolean;
    /** The SKIT home whose Registry credentials sync uses. */
    readonly home: string;
    readonly to?: string;
    readonly visibility?: AuthorVisibility;
  },
  registryAccess: Pick<AuthorRegistry<E, R, P>, "origin" | "connect">,
) {
  const workspaces = yield* AuthorWorkspace;
  const history = yield* AuthorHistory;
  const root = yield* workspaces.resolveRoot(rootInput);
  // Applying holds the workspace lease for the whole command; a preview takes none (A8).
  const lease = options.apply ? yield* workspaces.acquire(root) : undefined;
  const workspace = yield* workspaces.read(root);
  const { connection } = workspace;
  if (connection._tag === "Connected" && options.to)
    return yield* new AuthorRemoteAlreadyExists({ locator: skitLocator(connection.remote) });
  if (connection._tag === "Connected" && options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  // A bare `namespace/skit` names a SKIT on the ambient Registry.
  const requestedRemote = (to: string) =>
    Effect.gen(function* () {
      const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(to);
      return yield* parseAuthorDestination(to, concrete ? undefined : yield* registryAccess.origin);
    });
  // A first sync names its destination and visibility; a synced workspace has its remote home.
  const destination: Destination =
    connection._tag === "Connected"
      ? { _tag: "ConnectedRemote", remote: connection.remote }
      : connection._tag === "Connecting"
        ? connection
        : options.to === undefined
          ? yield* new MissingRequirement({
              command: "First author sync",
              requires: "--to <namespace/skit> and --visibility <private|unlisted|public>",
            })
          : options.visibility === undefined
            ? yield* new VisibilityNotAccepted({ reason: "required" })
            : {
                _tag: "NewRemote",
                remote: yield* requestedRemote(options.to),
                visibility: options.visibility,
              };
  if (destination._tag === "Connecting") {
    if (options.to !== undefined) {
      const requested = yield* requestedRemote(options.to);
      if (skitLocator(requested) !== skitLocator(destination.remote))
        return yield* new AuthorRemoteAlreadyExists({ locator: skitLocator(destination.remote) });
    }
    if (options.visibility !== undefined && options.visibility !== destination.visibility)
      return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  }
  const { remote } = destination;
  const owner = remote.namespace;
  const slug = remote.skit;
  const locator = skitLocator(remote);
  const identity = { authority: remote.origin, namespace: owner, skit: slug, locator };
  // A connection.json left beside skit.remote.json: only one naming the same remote is safe to
  // delete; anything else stops sync and changes nothing (A4).
  if (connection._tag === "Connected" && connection.leftover._tag === "Invalid")
    return yield* connection.leftover.error;
  if (connection._tag === "Connected" && connection.leftover._tag === "Mismatched")
    return yield* new AuthorSyncStateInvalid({
      path: join(root, ".skit", "connection.json"),
      reason: `it names ${skitLocator(connection.leftover.checkpoint.remote)}, not ${locator}`,
    });
  const api = yield* registryAccess.connect({
    remote,
    locator,
    requireAuthentication: options.to !== undefined,
  });

  // The workspace's files as sync saw them, saved to history first; the scan sync plans from must
  // be the tree that capture saved (A14), so a mismatch captures and scans again, a bounded
  // number of times.
  const observe = Effect.gen(function* () {
    const observation = yield* history.capture(root);
    return { observation, local: yield* scanAuthorSyncTree(root).pipe(Effect.result) };
  }).pipe(
    Effect.repeat({
      until: ({ observation, local }) =>
        Result.isFailure(local) || local.success.verbatimHash === observation.treeHash,
      times: 2,
    }),
    Effect.filterOrFail(
      ({ observation, local }) =>
        Result.isFailure(local) || local.success.verbatimHash === observation.treeHash,
      () => new LocalFilesChangedDuringSync(),
    ),
  );
  // Applying gives an identity-less workspace an identity-only registration: backup, never
  // installation. An existing registration is used as it is. Without workspace.json, the id of an
  // authored Collection imported from this root is reused (A3).
  const applying =
    lease === undefined
      ? undefined
      : yield* Effect.gen(function* () {
          const { identity } = workspace;
          const workspaceId = Option.isSome(identity)
            ? identity.value.workspaceId
            : yield* Effect.gen(function* () {
                const adopt = adoptFrom(
                  (yield* readLibraryWorkspaceClaims(options.home, root)).atRoot,
                );
                const created = yield* lease.register({
                  from: identity,
                  to: "IdentityOnly",
                  adopt,
                });
                return created.workspaceId;
              });
          if (connection._tag === "Connected" && connection.leftover._tag === "Matching")
            yield* lease.transition({
              from: { ...connection, leftover: connection.leftover },
              to: { _tag: "Connected" },
            });
          // Every observed tree is saved on this device before sync talks to the Registry.
          return { lease, workspaceId, ...(yield* observe) };
        });
  // A preview backs up an identified workspace as applying does. Without an identity it creates
  // nothing: it plans over the scan alone, from no checkpoint.
  const previewed =
    applying !== undefined || Option.isNone(workspace.identity)
      ? undefined
      : { workspaceId: workspace.identity.value.workspaceId, ...(yield* observe) };
  const scan =
    applying?.local ?? previewed?.local ?? Result.succeed(yield* scanAuthorSyncTree(root));
  const scanned: Result.Result<
    {
      readonly local: Effect.Success<ReturnType<typeof scanAuthorSyncTree>>;
      readonly localHash: History.TreeHash;
    },
    Effect.Error<ReturnType<typeof scanAuthorSyncTree>>
  > = Result.isFailure(scan)
    ? Result.fail(scan.failure)
    : Result.succeed({
        local: scan.success,
        localHash:
          applying === undefined && previewed === undefined
            ? yield* History.treeHash(scan.success.tree)
            : yield* history.retain(scan.success.tree),
      });
  // Preview cannot apply this inventory. Keep its refusal passive, before talking to the Registry.
  if (applying === undefined && Result.isFailure(scanned))
    return yield* Effect.fail(scanned.failure);
  // The engine's store reports what it cannot read back; that is unusable history.
  const storeFailure = (error: History.StoreError) => Effect.fail(authorHistoryStoreError(error));

  const registry = api.remote;
  // This workspace's checkpoint: none until it has an identity (A5). Decoding the saved
  // checkpoints comes before creating anything or replacing a base.
  const workspaceId = applying?.workspaceId ?? previewed?.workspaceId;
  const savedState =
    workspaceId === undefined
      ? Sync.Idle.make({ base: null })
      : yield* history.syncState.read({ workspaceId, locator });
  if (destination._tag !== "ConnectedRemote") {
    if (destination._tag === "NewRemote") {
      yield* api.requireAvailable;
    }
    if (applying === undefined) {
      const { local } = yield* Effect.fromResult(scanned);
      return {
        status: "first_sync_ready",
        changed: false,
        identity,
        visibility: destination.visibility,
        file_count: local.tree.length,
        effects: ["create_skit", "save_revision", "record_remote_home"],
      } satisfies AuthorSyncResult;
    }
    // A crash anywhere from here replays from the Connecting checkpoint. The owner returns the
    // connection it saved; anything but Connecting is not what this step planned.
    const pending =
      destination._tag === "Connecting"
        ? destination
        : yield* applying.lease
            .transition({
              from: { _tag: "Unconnected" },
              to: { _tag: "Connecting", remote, visibility: destination.visibility },
            })
            .pipe(
              Effect.filterOrElse(
                (saved): saved is Connecting => saved._tag === "Connecting",
                () =>
                  workspaces
                    .read(root)
                    .pipe(
                      Effect.flatMap((found) =>
                        Effect.fail(new AuthorWorkspaceConflict({ root, found })),
                      ),
                    ),
              ),
            );
    yield* api.create(pending.visibility, pending.requestId).pipe(
      // A definitive receipt mismatch proves this request did not create the destination.
      Effect.catchTag("DestinationExistsWithoutHistory", (error) =>
        applying.lease
          .transition({ from: pending, to: { _tag: "Unconnected" } })
          .pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
    // No revision writes precede this commit point. A pending retry can safely start at no base.
    yield* history.syncState.save(
      applying.lease,
      { workspaceId: applying.workspaceId, locator },
      { from: savedState, reset: { requestId: pending.requestId, remote: pending.remote } },
    );
    yield* applying.lease.transition({
      from: pending,
      to: { _tag: "Connected" },
      receipt: { requestId: pending.requestId, remote: pending.remote },
    });
  }

  if (Result.isFailure(scanned)) {
    // Normalization governs current-content writes, not raw backup. A stable observation can
    // still be retained remotely even when its symlinks or normalized names cannot be applied.
    if (applying !== undefined)
      yield* backupAuthorHistory(
        applying.lease,
        { workspaceId: applying.workspaceId, locator },
        applying.observation,
        registry,
      ).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
    return yield* Effect.fail(scanned.failure);
  }
  const { local, localHash } = scanned.success;
  const state =
    destination._tag === "ConnectedRemote" ? savedState : Sync.Idle.make({ base: null });
  const planned = yield* Sync.loadPlanInput({
    store: history.engineStore,
    remote: registry,
    state,
    local: { hash: localHash, tree: local.tree },
  }).pipe(
    Effect.map((view) => Sync.plan(view)),
    Effect.catchIf(Schema.is(History.StoreError), storeFailure),
  );
  if (applying === undefined)
    switch (planned._tag) {
      case "UpToDate":
        return {
          status: "up_to_date",
          changed: false,
          revision_id: planned.base,
        } satisfies AuthorSyncResult;
      case "Blocked":
        return { status: "blocked", changed: false, ...planned.removal } satisfies AuthorSyncResult;
      case "Pull":
        return { status: "ready", changed: false, action: "pull" } satisfies AuthorSyncResult;
      case "Write":
        return {
          status: "ready",
          changed: false,
          action: planned.input.state.next._tag === "Idle" ? "pull" : "merge",
        } satisfies AuthorSyncResult;
      case "Push":
        return { status: "ready", changed: false, action: "push" } satisfies AuthorSyncResult;
      case "Merge":
        return { status: "ready", changed: false, action: "merge" } satisfies AuthorSyncResult;
    }
  const key = { workspaceId: applying.workspaceId, locator };
  if (planned._tag === "Blocked" && !options.allowLargeDeletion)
    return { status: "blocked", changed: false, ...planned.removal } satisfies AuthorSyncResult;
  yield* backupAuthorHistory(applying.lease, key, applying.observation, registry).pipe(
    Effect.catchIf(Schema.is(History.StoreError), storeFailure),
  );
  // The checkpoint last saved, which every step names as its `from`.
  const last = yield* Ref.make<Sync.SyncState>(state);
  const { outcome } = yield* Sync.run({
    store: history.engineStore,
    remote: registry,
    state,
    local: localHash,
    author: applying.observation.revision.author,
    // This device applies every path it syncs.
    merger: authorTree({ excluded: new Set(), previouslyExcluded: new Set() }),
    decide: authorDecider,
    // Approval covers exactly the removal this sync found; any other removal still blocks.
    ...(options.allowLargeDeletion && planned._tag === "Blocked"
      ? { approved: planned.removal }
      : {}),
    // Every checkpoint step advances the lease.
    save: (next) =>
      Effect.gen(function* () {
        yield* history.syncState.save(applying.lease, key, {
          from: yield* Ref.get(last),
          to: next,
        });
        yield* Ref.set(last, next);
      }),
    // The step into Writing returns the PreparedWrite its one write uses up (A13).
    prepareWrite: (next) =>
      Effect.gen(function* () {
        const prepared = yield* history.syncState.prepareWrite(applying.lease, key, {
          from: yield* Ref.get(last),
          to: next,
        });
        yield* Ref.set(last, next);
        return prepared;
      }),
    // Any edit made since sync read the files is saved to history first, and stops the write.
    write: (prepared, from, to) =>
      history.capture(root).pipe(Effect.andThen(applying.lease.writeTree({ prepared, from, to }))),
  }).pipe(Effect.catchIf(Schema.is(History.StoreError), storeFailure));
  if (outcome.status === "blocked")
    return { status: "blocked", changed: false, ...outcome.removal } satisfies AuthorSyncResult;
  // Record what sync wrote as this workspace's latest observation.
  const completed = yield* history.capture(root);
  yield* backupAuthorHistory(applying.lease, key, completed, registry).pipe(
    Effect.catchIf(Schema.is(History.StoreError), storeFailure),
  );
  if (destination._tag !== "ConnectedRemote")
    return {
      status: "created",
      changed: true,
      identity,
      visibility: destination.visibility,
      revision_id: outcome.revision,
      paths: local.tree.map((entry) => entry.path).sort(),
      // This field means first sync persisted the repository's remote home.
      remote_home_recorded: true,
      published: false,
    } satisfies AuthorSyncResult;
  switch (outcome.status) {
    case "up_to_date":
      return {
        status: "up_to_date",
        changed: false,
        revision_id: outcome.revision,
      } satisfies AuthorSyncResult;
    case "pushed":
      return {
        status: "pushed",
        changed: true,
        revision_id: outcome.revision,
      } satisfies AuthorSyncResult;
    case "pulled":
      return {
        status: "pulled",
        changed: true,
        revision_id: outcome.revision,
        paths: outcome.paths,
      } satisfies AuthorSyncResult;
    case "merged":
      return {
        status: "merged",
        changed: true,
        revision_id: outcome.revision,
        paths: outcome.paths,
        choices: outcome.choices.map(({ conflict, kept }) => ({
          path: String(conflict.at[0]),
          kind: conflictKind(conflict),
          kept: kept === "ours" ? "local" : "remote",
        })),
      } satisfies AuthorSyncResult;
  }
}, Effect.scoped);
