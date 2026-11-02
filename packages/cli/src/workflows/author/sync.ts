import { configurationForHome } from "../../configuration/skit-configuration.js";
import {
  AuthoringAuthenticatedApi,
  CurrentMovedResponse,
  DraftExistsResponse,
  DraftNotFoundResponse,
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
  RemoteDraftUnavailable,
  VisibilityNotAccepted,
} from "../../registry/failures.js";
import type { AuthorSyncResult, AuthorVisibility } from "./sync-contract.js";
import { historyDirectory, saveAuthorWorkspace } from "./history.js";
import { withDeviceStore } from "./device-store.js";
import { authorDecider, authorTree } from "./device-view.js";
import { readAuthorSyncTree } from "./local-tree.js";

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

/** A Draft request the Registry answered, with its own words for why it refused. */
export class SyncRejected
  extends Data.TaggedError("SyncRejected")<{ message: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check the Registry's reason, then sync again.";
}

/** One sync state per Draft, by the Draft's `skit://` locator. */
const SyncBindings = Schema.Struct({
  schema: Schema.Literal("skit.sync-bindings.v2"),
  drafts: Schema.Record(Schema.String, Sync.SyncState),
});
type SyncBindings = typeof SyncBindings.Type;
/** The pre-release format, a base copy of every file per Draft, recognized only to drop it. */
const PreReleaseBindings = Schema.Record(
  Schema.String,
  Schema.Struct({ skitId: Schema.String, revisionId: Schema.String }),
);
const BindingsDocument = Schema.fromJsonString(Schema.Union([SyncBindings, PreReleaseBindings]));

export type AuthorRemoteHome = {
  schema: "skit.remote.v1";
  origin: string;
  namespace: string;
  skit: string;
};

/** Excess properties are an error: this document is exhaustive, and the previous reader
 * rejected any key set but these four. */
const AuthorRemoteDocument = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal("skit.remote.v1"),
    origin: Schema.String,
    namespace: Schema.String,
    skit: Schema.String,
  }),
);

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

export function readAuthorRemote(
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

const writeRemote = Effect.fn("Sync.writeRemote")(function* (
  root: string,
  remote: AuthorRemoteHome,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = remotePath(root);
  const temporary = `${path}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(remote, null, 2)}\n`, {
    mode: 0o644,
  });
  yield* fs.rename(temporary, path);
});

/**
 * Load the sync state of every Draft. Pre-release bindings name Draft revisions the Registry no
 * longer has, so they are dropped and each Draft syncs again from no base.
 */
const loadBindings = Effect.fn("Sync.loadBindings")(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString((yield* configurationForHome(home)).syncBindingsPath)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (text === undefined) return {};
  // A malformed file is a defect, as it always was.
  const document = yield* Schema.decodeUnknownEffect(BindingsDocument)(text).pipe(Effect.orDie);
  return Schema.is(SyncBindings)(document) ? document.drafts : {};
});

/** Save one Draft's sync state durably: flushed, then renamed over the old file. */
const saveBinding = Effect.fn("Sync.saveBinding")(function* (
  home: string | undefined,
  locator: string,
  state: Sync.SyncState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = (yield* configurationForHome(home)).syncBindingsPath;
  const bindings: SyncBindings = {
    schema: "skit.sync-bindings.v2",
    drafts: { ...(yield* loadBindings(home)), [locator]: state },
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
      const text = yield* Schema.encodeEffect(Schema.fromJsonString(SyncBindings))(bindings).pipe(
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
 * a Draft is refused rather than dropped.
 */
const writeAuthorTree = Effect.fn("Sync.writeTree")(function* (
  root: string,
  home: string | undefined,
  from: History.Tree,
  to: History.Tree,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* saveAuthorWorkspace(root, home);
  const local = yield* readAuthorSyncTree(root);
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
          message: `Author sync writes files only; the Draft holds a ${unsupported.kind} here`,
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

export const syncDraft = Effect.fn("Sync.draft")(function* (
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
  const storedRemote = yield* readAuthorRemote(root);
  if (storedRemote && options.to)
    return yield* new AuthorRemoteAlreadyExists({
      locator: skitLocator(storedRemote),
    });
  if (storedRemote && options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  // A first sync names its destination and visibility; a synced workspace has its remote home.
  const { remote, firstSync } = storedRemote
    ? { remote: storedRemote, firstSync: undefined }
    : options.to === undefined
      ? yield* new MissingRequirement({
          command: "First author sync",
          requires: "--to <namespace/skit> and --visibility <private|unlisted|public>",
        })
      : options.visibility === undefined
        ? yield* new VisibilityNotAccepted({ reason: "required" })
        : {
            remote: yield* parseAuthorDestination(options.to, configuredBase),
            firstSync: { visibility: options.visibility },
          };
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
  const observed = yield* saveAuthorWorkspace(root, options.home);
  const local = yield* readAuthorSyncTree(root);
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
    if (Schema.is(DraftNotFoundResponse)(error))
      return new RemoteDraftUnavailable({ identity: locator });
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
    current: client.drafts.current({ params }).pipe(
      Effect.map((draft) => draft.current),
      Effect.mapError(failure("draft current", 200)),
    ),
    revision: (id) =>
      client.drafts.revision({ params: { ...params, id } }).pipe(
        Effect.map(({ revision, tree }) => ({ revision, tree })),
        Effect.mapError(failure("draft revision", 200)),
      ),
    ancestors: (id) =>
      Stream.paginate(Option.none<string>(), (cursor) =>
        client.drafts
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
            Effect.mapError(failure("draft history", 200)),
          ),
      ),
    post: (id, revision, tree) =>
      client.drafts
        .post({ params, payload: { id, revision, tree } })
        .pipe(Effect.asVoid, Effect.mapError(failure("draft revision", 200))),
    move: (expected, id) =>
      client.drafts.move({ params, payload: { expected, id } }).pipe(
        Effect.asVoid,
        Effect.mapError((error) =>
          Schema.is(CurrentMovedResponse)(error)
            ? new Sync.Moved({ current: error.current })
            : failure("draft move", 200)(error),
        ),
      ),
  });
  if (firstSync !== undefined) {
    const existing = yield* client.drafts.current({ params }).pipe(Effect.result);
    if (Result.isSuccess(existing))
      return yield* new DestinationExistsWithoutHistory({ identity: locator });
    if (!Schema.is(DraftNotFoundResponse)(existing.failure))
      return yield* Effect.fail(failure("draft current", 200)(existing.failure));
    if (!options.apply)
      return {
        status: "first_sync_ready",
        changed: false,
        identity,
        visibility: firstSync.visibility,
        file_count: local.tree.length,
        effects: ["create_skit", "create_draft", "record_remote_home"],
      } satisfies AuthorSyncResult;
    yield* client.drafts
      .create({ payload: { owner, slug, visibility: firstSync.visibility } })
      .pipe(
        Effect.mapError((error) =>
          Schema.is(DraftExistsResponse)(error)
            ? new DestinationExistsWithoutHistory({ identity: locator })
            : failure("draft create", 201)(error),
        ),
      );
  }

  // A Draft this sync just created starts from no base, whatever an earlier binding said.
  const state =
    (firstSync === undefined ? (yield* loadBindings(options.home))[locator] : undefined) ??
    Sync.Idle.make({ base: null });
  const planned = yield* Sync.view(state, localHash).pipe(
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
          action: planned.view.state.next._tag === "Idle" ? "pull" : "merge",
        } satisfies AuthorSyncResult;
      case "Push":
        return { status: "ready", changed: false, action: "push" } satisfies AuthorSyncResult;
      case "Merge":
        return { status: "ready", changed: false, action: "merge" } satisfies AuthorSyncResult;
    }
  const { outcome } = yield* Sync.run({
    state,
    local: localHash,
    author: observed.revision.author,
    // This device applies every path it syncs.
    merger: authorTree({ excluded: new Set(), previouslyExcluded: new Set() }),
    decide: authorDecider,
    // Approval covers exactly the removal this sync found; any other removal still blocks.
    ...(options.allowLargeDeletion && planned._tag === "Blocked"
      ? { approved: planned.removal }
      : {}),
    save: (next) => saveBinding(options.home, locator, next),
    write: (from, to) => writeAuthorTree(root, options.home, from, to),
  }).pipe(Effect.provideService(Sync.Remote, registry), withDeviceStore(directory));
  if (outcome.status === "blocked")
    return { status: "blocked", changed: false, ...outcome.removal } satisfies AuthorSyncResult;
  if (firstSync !== undefined) yield* writeRemote(root, remote);
  // Record what sync wrote as this workspace's latest observation.
  yield* saveAuthorWorkspace(root, options.home);
  if (firstSync !== undefined)
    return {
      status: "created",
      changed: true,
      identity,
      visibility: firstSync.visibility,
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
