import { configurationForHome } from "../../configuration/skit-configuration.js";
import {
  AuthoringAuthenticatedApi,
  CurrentMovedResponse,
  SkitExistsResponse,
  SkitNotFoundResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, FileSystem, Option, Ref, Result, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailureMessage,
} from "../../registry/api-client.js";
import { isRegistryTransportError, RegistryHttp } from "../../registry/registry-http.js";
import { dirname, join } from "node:path";
import { isErrno } from "../../platform/errno.js";
import {
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  AuthorRemoteAlreadyExists,
  RemoteSkitUnavailable,
  VisibilityNotAccepted,
} from "../../registry/failures.js";
import type { AuthorSyncResult, AuthorVisibility } from "./sync-contract.js";
import { historyDirectory, refreshAuthorHistory } from "./history.js";
import { withDeviceStore } from "./device-store.js";
import { authorDecider, authorTree } from "./device-view.js";
import { scanAuthorSyncTree } from "./local-tree.js";
import { decodeUrl, normalizeRemote, type AuthorRemoteHome } from "../../author/remote.js";
import {
  AuthorSyncStateInvalid,
  AuthorWorkspace,
  type Connecting,
  type PreparedWrite,
  mintPreparedWrite,
} from "../../author/workspace.js";

export type { AuthorVisibility } from "./sync-contract.js";
export type { AuthorRemoteHome } from "../../author/remote.js";
export { AuthorSyncStateInvalid } from "../../author/workspace.js";
import { History, conflictKind, SkitContractError, Sync } from "@smolai/skit-core";
import { MissingRequirement } from "../failures.js";
import {
  DestinationExistsWithoutHistory,
  DestinationFormInvalid,
  RegistryMismatch,
  RegistryUnreachable,
} from "../../registry/failures.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
} from "../../registry/failures.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

/** A SKIT request the Registry answered, with its own words for why it refused. */
export class SyncRejected
  extends Data.TaggedError("SyncRejected")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then sync again.";
}

/** One sync state per SKIT, by the SKIT's `skit://` locator. */
const SavedSyncStates = Schema.Struct({
  schema: Schema.Literal("skit.sync-bindings.v3"),
  skits: Schema.Record(Schema.String, Sync.SyncState),
});
/** Read-only compatibility for checkpoints written before SKITs owned their revisions. */
const LegacySyncStates = Schema.Struct({
  schema: Schema.Literal("skit.sync-bindings.v2"),
  drafts: Schema.Record(Schema.String, Sync.SyncState),
});
type SavedSyncStates = typeof SavedSyncStates.Type;
/** The pre-release format, a base copy of every file per SKIT, recognized only to drop it. */
const PreReleaseBindings = Schema.Record(
  Schema.String,
  Schema.Struct({ skitId: Schema.String, revisionId: Schema.String }),
);
const SyncStatesDocument = Schema.fromJsonString(
  Schema.Union([SavedSyncStates, LegacySyncStates, PreReleaseBindings]),
);

const decodeAuthorSegment = (input: string) =>
  Schema.decodeUnknownEffect(Schema.StringFromUriComponent)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "URI malformed" })),
  );

export const parseAuthorDestination = Effect.fn("Author.parseDestination")(function* (
  input: string,
  registryOrigin?: string,
) {
  if (input.startsWith("skit://")) {
    const url = yield* decodeUrl(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      return yield* new DestinationFormInvalid({ form: "canonical" });
    return yield* normalizeRemote({
      origin: `https://${url.host}`,
      namespace: yield* decodeAuthorSegment(parts[0]),
      skit: yield* decodeAuthorSegment(parts[1]),
    });
  }
  if (/^https?:\/\//.test(input)) {
    const url = yield* decodeUrl(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      return yield* new AuthorDestinationInvalid({ form: "https" });
    return yield* normalizeRemote({
      origin: url.origin,
      namespace: yield* decodeAuthorSegment(parts[0]),
      skit: yield* decodeAuthorSegment(parts[1]),
    });
  }
  const parts = input.split("/");
  if (parts.length !== 2 || !registryOrigin)
    return yield* registryOrigin
      ? new AuthorDestinationInvalid({ form: "bare" })
      : new DestinationFormInvalid({ form: "relative-without-registry" });
  return yield* normalizeRemote({
    origin: registryOrigin,
    namespace: parts[0],
    skit: parts[1],
  });
});

export function skitLocator(remote: AuthorRemoteHome): string {
  const authority = new URL(remote.origin).host;
  return `skit://${authority}/${remote.namespace}/${remote.skit}`;
}

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
 * Load the sync state of every SKIT. Pre-release bindings name SKIT revisions the Registry no
 * longer has, so they are dropped and each SKIT syncs again from no base.
 */
const loadSyncStates = Effect.fn("Sync.loadSyncStates")(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = (yield* configurationForHome(home)).syncBindingsPath;
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return {};
  const document = yield* Schema.decodeUnknownEffect(SyncStatesDocument)(text).pipe(
    Effect.mapError((error) => new AuthorSyncStateInvalid({ path, reason: String(error) })),
  );
  return Schema.is(SavedSyncStates)(document)
    ? document.skits
    : Schema.is(LegacySyncStates)(document)
      ? document.drafts
      : {};
});

/** Save one SKIT's sync state durably: flushed, then renamed over the old file. */
const saveSyncState = Effect.fn("Sync.saveSyncState")(function* (
  home: string | undefined,
  locator: string,
  state: Sync.SyncState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = (yield* configurationForHome(home)).syncBindingsPath;
  const states: SavedSyncStates = {
    schema: "skit.sync-bindings.v3",
    skits: { ...(yield* loadSyncStates(home)), [locator]: state },
  };
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: dirname(path),
        prefix: ".sync-state-",
      });
      const temporary = join(staging, "state.json");
      const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
      // The bindings are built from decoded states, so failing to encode them is a defect.
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(SavedSyncStates))(states).pipe(
        Effect.orDie,
      );
      yield* file.writeAll(new TextEncoder().encode(text));
      yield* file.sync;
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* fs.rename(temporary, path);
          const directory = yield* fs.open(dirname(path), { flag: "r" });
          yield* directory.sync;
        }),
      );
    }),
  );
});

export const syncAuthorWorkspace = Effect.fn("Sync.skit")(function* (
  rootInput: string,
  options: {
    apply: boolean;
    allowLargeDeletion?: boolean;
    home?: string;
    baseUrl?: string;
    token?: string;
    to?: string;
    visibility?: AuthorVisibility;
  },
) {
  const workspaces = yield* AuthorWorkspace;
  const root = yield* workspaces.resolveRoot(rootInput);
  const configuredBase = options.baseUrl;
  // Applying holds the workspace lease for the whole command; a preview takes none (A8).
  const lease = options.apply ? yield* workspaces.acquire(root) : undefined;
  const workspace = yield* workspaces.read(root);
  const { connection } = workspace;
  const storedRemote = connection._tag === "Connected" ? connection.remote : undefined;
  if (storedRemote && options.to)
    return yield* new AuthorRemoteAlreadyExists({
      locator: skitLocator(storedRemote),
    });
  if (storedRemote && options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "already-synced" });
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
                remote: yield* parseAuthorDestination(options.to, configuredBase),
                visibility: options.visibility,
              };
  if (destination._tag === "Connecting") {
    if (options.to !== undefined) {
      const requested = yield* parseAuthorDestination(options.to, configuredBase);
      if (skitLocator(requested) !== skitLocator(destination.remote))
        return yield* new AuthorRemoteAlreadyExists({ locator: skitLocator(destination.remote) });
    }
    if (options.visibility !== undefined && options.visibility !== destination.visibility)
      return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  }
  const { remote } = destination;
  const base = remote.origin;
  const owner = remote.namespace;
  const slug = remote.skit;
  if (configuredBase && new URL(configuredBase).origin !== base)
    return yield* new RegistryMismatch({
      active: new URL(configuredBase).origin,
      expected: base,
      subject: "author destination",
    });
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
  // Applying gives an identity-less workspace an identity-only registration: backup, never
  // installation. An existing registration is used as it is.
  const applying =
    lease === undefined
      ? undefined
      : {
          lease,
          workspaceId: Option.isSome(workspace.identity)
            ? workspace.identity.value.workspaceId
            : (yield* lease.register({
                from: workspace.identity,
                to: "IdentityOnly",
                adopt: Option.none(),
              })).workspaceId,
        };
  if (
    applying !== undefined &&
    connection._tag === "Connected" &&
    connection.leftover._tag === "Matching"
  )
    yield* applying.lease.transition({
      from: { ...connection, leftover: connection.leftover },
      to: { _tag: "Connected" },
    });

  // Every observed tree is saved on this device before sync talks to the Registry.
  const saved = yield* refreshAuthorHistory(root, options.home);
  const local = yield* scanAuthorSyncTree(root);
  const directory = yield* historyDirectory(options.home);
  const localHash = yield* Effect.flatMap(History.Store, (history) =>
    history.putTree(local.tree),
  ).pipe(withDeviceStore(directory));

  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient: transport,
    baseUrl: base,
  }).pipe(Effect.provide(authenticatedApiMiddleware(options.token)));
  const failure = (context: string, successStatus: number) => (error: unknown) => {
    if (isRegistryTransportError(error))
      return new RegistryUnreachable({ origin: base, cause: error.cause });
    if (Schema.is(UnauthorizedResponse)(error))
      return new AuthenticationRequired({ scopes: "library:sync,authoring:write" });
    if (Schema.is(InsufficientScopeResponse)(error))
      return new CredentialLacksScope({
        scope: "authoring:write",
        scopes: "library:sync,authoring:write",
      });
    if (Schema.is(ForbiddenResponse)(error) || Schema.is(ForbiddenOriginResponse)(error))
      return new PrincipalNotAuthorized({ action: "author this Namespace or SKIT" });
    if (Schema.is(SkitNotFoundResponse)(error))
      return new RemoteSkitUnavailable({ identity: locator });
    if (isSuccessfulResponseDecodeFailure(error, [successStatus]))
      return new SkitContractError({
        contract: `${context} response`,
        issues: [{ path: "", message: String(error) }],
      });
    return new SyncRejected({
      message: registryApiFailureMessage(context, error, { defaultStatus: 400 }),
    });
  };
  const params = { owner, slug };
  const registry = Sync.Remote.of({
    current: client.skits.current({ params }).pipe(
      Effect.map((skit) => skit.current),
      Effect.mapError(failure("skit current", 200)),
    ),
    revision: (id) =>
      client.skits.revision({ params: { ...params, id } }).pipe(
        Effect.map(({ revision, tree }) => ({ revision, tree })),
        Effect.mapError(failure("skit revision", 200)),
      ),
    ancestors: (id) =>
      Stream.paginate(Option.none<string>(), (cursor) =>
        client.skits
          .ancestors({
            params,
            query: Option.match(cursor, {
              onNone: () => ({ ancestors: id }),
              onSome: (next) => ({ ancestors: id, cursor: next }),
            }),
          })
          .pipe(
            Effect.map(
              (page) =>
                [
                  page.revisions.map(({ id, revision }) => ({ id, revision })),
                  Option.map(Option.fromNullishOr(page.next_cursor), Option.some),
                ] as const,
            ),
            Effect.mapError(failure("skit history", 200)),
          ),
      ),
    post: (id, revision, tree) =>
      client.skits
        .post({ params, payload: { id, revision, tree } })
        .pipe(Effect.asVoid, Effect.mapError(failure("skit revision", 200))),
    move: (expected, id) =>
      client.skits.move({ params, payload: { expected, id } }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          Schema.is(CurrentMovedResponse)(error)
            ? new Sync.Moved({ current: error.current })
            : failure("skit move", 200)(error),
        ),
      ),
  });
  // Decode all saved checkpoints before creating anything or replacing a base.
  const states = yield* loadSyncStates(options.home);
  if (destination._tag !== "ConnectedRemote") {
    if (destination._tag === "NewRemote") {
      const existing = yield* client.skits.current({ params }).pipe(Effect.result);
      if (Result.isSuccess(existing))
        return yield* new DestinationExistsWithoutHistory({ identity: locator });
      if (!Schema.is(SkitNotFoundResponse)(existing.failure))
        return yield* Effect.fail(failure("skit current", 200)(existing.failure));
    }
    if (applying === undefined)
      return {
        status: "first_sync_ready",
        changed: false,
        identity,
        visibility: destination.visibility,
        file_count: local.tree.length,
        effects: ["create_skit", "save_revision", "record_remote_home"],
      } satisfies AuthorSyncResult;
    const started =
      destination._tag === "Connecting"
        ? destination
        : yield* applying.lease.transition({
            from: { _tag: "Unconnected" },
            to: { _tag: "Connecting", remote, visibility: destination.visibility },
          });
    if (started._tag !== "Connecting")
      return yield* Effect.die(`Connecting returned ${started._tag}`);
    const pending = started;
    yield* client.skits
      .create({
        payload: { owner, slug, visibility: pending.visibility, request_id: pending.requestId },
      })
      .pipe(
        Effect.mapError((error) =>
          Schema.is(SkitExistsResponse)(error)
            ? new DestinationExistsWithoutHistory({ identity: locator })
            : failure("skit create", 201)(error),
        ),
        // A definitive receipt mismatch proves this request did not create the destination.
        Effect.catchTag("DestinationExistsWithoutHistory", (error) =>
          applying.lease
            .transition({ from: pending, to: { _tag: "Unconnected" } })
            .pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // No revision writes precede this commit point. A pending retry can safely start at no base.
    yield* saveSyncState(options.home, locator, Sync.Idle.make({ base: null }));
    yield* applying.lease.advance;
    yield* applying.lease.transition({
      from: pending,
      to: { _tag: "Connected" },
      receipt: { requestId: pending.requestId, remote: pending.remote },
    });
  }

  const state =
    (destination._tag === "ConnectedRemote" ? states[locator] : undefined) ??
    Sync.Idle.make({ base: null });
  const planned = yield* Sync.loadPlanInput(state, localHash).pipe(
    Effect.map((view) => Sync.plan(view)),
    Effect.provideService(Sync.Remote, registry),
    withDeviceStore(directory),
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
  // The PreparedWrite for the Writing checkpoint just saved; each write uses its own up.
  const prepared = yield* Ref.make(Option.none<PreparedWrite>());
  const { outcome } = yield* Sync.run({
    state,
    local: localHash,
    author: saved.revision.author,
    // This device applies every path it syncs.
    merger: authorTree({ excluded: new Set(), previouslyExcluded: new Set() }),
    decide: authorDecider,
    // Approval covers exactly the removal this sync found; any other removal still blocks.
    ...(options.allowLargeDeletion && planned._tag === "Blocked"
      ? { approved: planned.removal }
      : {}),
    // Every checkpoint step advances the lease; the step into Writing mints the write's token
    // (until AuthorHistory.syncState.prepareWrite exists).
    save: (next) =>
      saveSyncState(options.home, locator, next).pipe(
        Effect.andThen(
          next._tag === "Writing"
            ? mintPreparedWrite(applying.lease, key, { from: next.from, to: next.to }).pipe(
                Effect.flatMap((token) => Ref.set(prepared, Option.some(token))),
              )
            : applying.lease.advance,
        ),
      ),
    // Any edit made since sync read the files is saved to history first, and stops the write.
    write: (from, to) =>
      Effect.gen(function* () {
        yield* refreshAuthorHistory(root, options.home);
        const token = yield* Ref.getAndSet(prepared, Option.none());
        yield* applying.lease.writeTree({
          // The engine's recovered merge writes a tree no saved checkpoint names (A12; core
          // sync.ts Write case). Until AuthorHistory saves a Writing for it, mint one here.
          prepared: Option.isSome(token)
            ? token.value
            : yield* mintPreparedWrite(applying.lease, key, {
                from: yield* History.treeHash(from),
                to: yield* History.treeHash(to),
              }),
          from,
          to,
        });
      }),
  }).pipe(Effect.provideService(Sync.Remote, registry), withDeviceStore(directory));
  if (outcome.status === "blocked")
    return { status: "blocked", changed: false, ...outcome.removal } satisfies AuthorSyncResult;
  // Record what sync wrote as this workspace's latest observation.
  yield* refreshAuthorHistory(root, options.home);
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
});
