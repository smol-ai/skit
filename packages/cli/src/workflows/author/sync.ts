import { randomUUID } from "node:crypto";
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
import { Data, Effect, FileSystem, Option, Result, Schema, Stream } from "effect";
import { HttpApiClient } from "effect/http-api";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  registryApiFailureMessage,
} from "../../registry/api-client.js";
import { isRegistryTransportError, RegistryHttp } from "../../registry/registry-http.js";
import { dirname, join, resolve } from "node:path";
import { isErrno } from "../../platform/errno.js";
import {
  AuthorDestinationInvalid,
  AuthorDestinationMalformed,
  AuthorRemoteAlreadyExists,
  AuthorRemoteMetadataInvalid,
  InsecureOrigin,
  LocalFilesChangedDuringSync,
  RemoteSkitUnavailable,
  VisibilityNotAccepted,
} from "../../registry/failures.js";
import type { AuthorSyncResult, AuthorVisibility } from "./sync-contract.js";
import { historyDirectory, refreshAuthorHistory } from "./history.js";
import { withDeviceStore } from "./device-store.js";
import { authorDecider, authorTree } from "./device-view.js";
import { scanAuthorSyncTree } from "./local-tree.js";

export type { AuthorVisibility } from "./sync-contract.js";
import {
  History,
  conflictKind,
  LinkStat,
  normalizeRegistryNamespace,
  normalizeRegistrySkitSlug,
  SkitContractError,
  Sync,
  TreeEntry,
  writeJsonExclusive,
  writeRawAtomic,
  syncPaths,
} from "@smolai/skit-core";
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

/** Saved recovery state must be readable before sync may change files or the Registry. */
export class AuthorSyncStateInvalid
  extends Schema.TaggedError<AuthorSyncStateInvalid>()("AuthorSyncStateInvalid", {
    path: Schema.String,
    reason: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `Author sync state at ${this.path} is invalid: ${this.reason}`;
  }
  readonly remediation = "Keep the sync state file and repair or restore it before syncing again.";
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

/** Excess properties are an error: this document is exhaustive, and the previous reader
 * rejected any key set but these four. */
const AuthorRemoteHome = Schema.Struct({
  schema: Schema.Literal("skit.remote.v1"),
  origin: Schema.String,
  namespace: Schema.String,
  skit: Schema.String,
});
export type AuthorRemoteHome = typeof AuthorRemoteHome.Type;
const AuthorRemoteDocument = Schema.fromJsonString(AuthorRemoteHome);

const decodeAuthorRemote = Schema.decodeUnknownEffect(AuthorRemoteDocument, {
  onExcessProperty: "error",
});

function remotePath(root: string) {
  return join(root, "skit.remote.json");
}

const decodeUrl = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "Invalid URL" })),
  );

const decodeAuthorSegment = (input: string) =>
  Schema.decodeUnknownEffect(Schema.StringFromUriComponent)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "URI malformed" })),
  );

const normalizeRemote = Effect.fn("Author.normalizeRemote")(function* (
  value: Omit<AuthorRemoteHome, "schema">,
) {
  const origin = (yield* decodeUrl(value.origin)).origin;
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  )
    return yield* new InsecureOrigin({ purpose: "author remote" });
  const namespace = normalizeRegistryNamespace(value.namespace);
  const skit = normalizeRegistrySkitSlug(value.skit);
  if (!namespace || !skit) return yield* new AuthorDestinationInvalid({ form: "bare" });
  return { schema: "skit.remote.v1" as const, origin, namespace, skit };
});

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

export function loadAuthorRemote(
  root: string,
): Effect.Effect<AuthorRemoteHome | undefined, AuthorRemoteMetadataInvalid, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(remotePath(root))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isErrno(error, "ENOENT")
            ? Effect.succeed(undefined)
            : Effect.fail(new AuthorRemoteMetadataInvalid({ path: remotePath(root) })),
        ),
      );
    if (text === undefined) return undefined;
    // Metadata parsing classifies all malformed remote values as a conflict.
    const invalid = () => new AuthorRemoteMetadataInvalid({ path: remotePath(root) });
    const document = yield* decodeAuthorRemote(text).pipe(Effect.mapError(invalid));
    const normalized = yield* normalizeRemote(document).pipe(
      Effect.catchTags({
        AuthorDestinationInvalid: () => Effect.fail(invalid()),
        AuthorDestinationMalformed: () => Effect.fail(invalid()),
        InsecureOrigin: () => Effect.fail(invalid()),
      }),
    );
    if (
      document.origin !== normalized.origin ||
      document.namespace !== normalized.namespace ||
      document.skit !== normalized.skit
    )
      return yield* Effect.fail(invalid());
    return normalized;
  });
}

/** First connection is recoverable independently of revision transfer. */
const SyncDestination = Schema.TaggedUnion({
  NewRemote: {
    remote: AuthorRemoteHome,
    visibility: Schema.Literals(["private", "unlisted", "public"]),
  },
  Connecting: {
    remote: AuthorRemoteHome,
    visibility: Schema.Literals(["private", "unlisted", "public"]),
    requestId: Schema.String.check(Schema.isMinLength(1)),
  },
  ConnectedRemote: { remote: AuthorRemoteHome },
});
type SyncDestination = typeof SyncDestination.Type;
const Connecting = SyncDestination.cases.Connecting;
type Connecting = typeof Connecting.Type;
const connectionPath = (root: string) => join(root, ".skit", "connection.json");

const loadAuthorConnection = Effect.fn("Sync.loadConnection")(function* (root: string) {
  const remote = yield* loadAuthorRemote(root);
  if (remote !== undefined) return SyncDestination.cases.ConnectedRemote.make({ remote });
  const fs = yield* FileSystem.FileSystem;
  const path = connectionPath(root);
  const text = yield* fs
    .readFileString(path)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return undefined;
  const pending = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Connecting), {
    onExcessProperty: "error",
  })(text).pipe(
    Effect.mapError((error) => new AuthorSyncStateInvalid({ path, reason: String(error) })),
  );
  const normalized = yield* normalizeRemote(pending.remote).pipe(
    Effect.mapError((error) => new AuthorSyncStateInvalid({ path, reason: String(error) })),
  );
  if (
    normalized.origin !== pending.remote.origin ||
    normalized.namespace !== pending.remote.namespace ||
    normalized.skit !== pending.remote.skit
  )
    return yield* new AuthorSyncStateInvalid({ path, reason: "Noncanonical destination" });
  return pending;
});

/** The credential origin for both a pending and a completed connection. */
export const loadAuthorSyncRemote = Effect.fn("Sync.loadRemote")(function* (root: string) {
  return (yield* loadAuthorConnection(resolve(root)))?.remote;
});

const saveAuthorConnection = Effect.fn("Sync.saveConnection")(function* (
  root: string,
  connection: Connecting,
) {
  const path = connectionPath(root);
  yield* writeJsonExclusive(path, connection);
  // Flush the new checkpoint and both directory entries before any network mutation.
  yield* syncPaths([path, dirname(path), root]);
});

const removeAuthorConnection = Effect.fn("Sync.removeConnection")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(connectionPath(root));
  yield* syncPaths([dirname(connectionPath(root))]);
});

const writeRemote = Effect.fn("Sync.writeRemote")(function* (
  root: string,
  remote: AuthorRemoteHome,
) {
  const path = remotePath(root);
  yield* writeRawAtomic(path, `${JSON.stringify(remote, null, 2)}\n`, false, 0o644);
  yield* syncPaths([path, root]);
});

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

/**
 * Make the workspace's files `to`, if they are still `from`. Any edit made since sync read them is
 * saved to history first and stops the write. Only files are written: a directory or symlink in
 * a SKIT is refused rather than dropped.
 */
const writeAuthorTree = Effect.fn("Sync.writeTree")(function* (
  root: string,
  home: string | undefined,
  from: History.Tree,
  to: History.Tree,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* refreshAuthorHistory(root, home);
  const local = yield* scanAuthorSyncTree(root);
  if ((yield* History.treeHash(local.tree)) !== (yield* History.treeHash(from)))
    return yield* new LocalFilesChangedDuringSync();
  const before = new Map(
    from.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry] as const] : [])),
  );
  const files = to.flatMap((entry) => (entry.kind === "file" ? [entry] : []));
  const unsupported = to.find((entry) => entry.kind !== "file");
  if (unsupported !== undefined)
    return yield* new SkitContractError({
      contract: "Author sync tree",
      issues: [
        {
          path: unsupported.path,
          message: `Author sync writes files only; the SKIT holds a ${unsupported.kind} here`,
        },
      ],
    });
  const changed = files.filter((entry) => {
    const was = before.get(entry.path);
    return was === undefined || !Schema.toEquivalence(TreeEntry)(was, entry);
  });
  const kept = new Set(files.map((entry) => entry.path));
  const removed = [...before.keys()].filter((path) => !kept.has(path));
  // Check every target before writing any.
  for (const entry of changed) yield* local.checkTarget(entry.path);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({ prefix: "skit-sync-stage-" });
      for (const entry of changed) {
        const staged = join(staging, ...entry.path.split("/"));
        yield* fs.makeDirectory(dirname(staged), { recursive: true });
        yield* fs.writeFile(staged, entry.bytes);
        yield* fs.chmod(staged, entry.mode);
      }
      for (const entry of changed) {
        const absolute = yield* local.checkTarget(entry.path);
        yield* fs.makeDirectory(dirname(absolute), { recursive: true });
        yield* fs.rename(
          join(staging, ...entry.path.split("/")),
          yield* local.checkTarget(entry.path),
        );
      }
    }),
  );
  for (const path of removed) yield* fs.remove(yield* local.checkTarget(path));
  // Remove the folders those deletions emptied, deepest first. Each held a removed file, so none
  // was empty before; one that still holds anything, ignored files included, stays.
  const links = yield* LinkStat;
  const folders = [
    ...new Set(
      removed.flatMap((path) =>
        path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/")),
      ),
    ),
  ].sort((left, right) => right.split("/").length - left.split("/").length);
  for (const folder of folders) yield* links.removeEmptyDirectory(join(root, ...folder.split("/")));
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
  const root = resolve(rootInput);
  const configuredBase = options.baseUrl;
  const connection = yield* loadAuthorConnection(root);
  const storedRemote = connection?._tag === "ConnectedRemote" ? connection.remote : undefined;
  if (storedRemote && options.to)
    return yield* new AuthorRemoteAlreadyExists({
      locator: skitLocator(storedRemote),
    });
  if (storedRemote && options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  // A first sync names its destination and visibility; a synced workspace has its remote home.
  const destination: SyncDestination = connection
    ? connection
    : options.to === undefined
      ? yield* new MissingRequirement({
          command: "First author sync",
          requires: "--to <namespace/skit> and --visibility <private|unlisted|public>",
        })
      : options.visibility === undefined
        ? yield* new VisibilityNotAccepted({ reason: "required" })
        : SyncDestination.cases.NewRemote.make({
            remote: yield* parseAuthorDestination(options.to, configuredBase),
            visibility: options.visibility,
          });
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
    if (!options.apply)
      return {
        status: "first_sync_ready",
        changed: false,
        identity,
        visibility: destination.visibility,
        file_count: local.tree.length,
        effects: ["create_skit", "save_revision", "record_remote_home"],
      } satisfies AuthorSyncResult;
    const pending =
      destination._tag === "Connecting"
        ? destination
        : Connecting.make({ remote, visibility: destination.visibility, requestId: randomUUID() });
    if (destination._tag === "NewRemote") yield* saveAuthorConnection(root, pending);
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
          removeAuthorConnection(root).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
    // No revision writes precede this commit point. A pending retry can safely start at no base.
    yield* saveSyncState(options.home, locator, Sync.Idle.make({ base: null }));
    yield* writeRemote(root, remote);
    yield* removeAuthorConnection(root);
  }

  const state =
    (destination._tag === "ConnectedRemote" ? states[locator] : undefined) ??
    Sync.Idle.make({ base: null });
  const planned = yield* Sync.loadPlanInput(state, localHash).pipe(
    Effect.map((view) => Sync.plan(view)),
    Effect.provideService(Sync.Remote, registry),
    withDeviceStore(directory),
  );
  if (!options.apply)
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
    save: (next) => saveSyncState(options.home, locator, next),
    write: (from, to) => writeAuthorTree(root, options.home, from, to),
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
