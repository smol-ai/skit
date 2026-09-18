import {
  AuthoringAuthenticatedApi,
  DraftNotFoundResponse,
  ForbiddenOriginResponse,
  ForbiddenResponse,
  InsufficientScopeResponse,
  UnauthorizedResponse,
} from "@smolai/skit-core/universal/api";
import { Data, Effect, FileSystem, Predicate, Result, Schema } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  authenticatedApiMiddleware,
  isSuccessfulResponseDecodeFailure,
  mapRegistryFailureCause,
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
  NoAuthorRemote,
  RemoteDraftIdentityMismatch,
  RemoteDraftUnavailable,
  SyncBlockedByValidation,
  VisibilityNotAccepted,
} from "../../registry/failures.js";
import type { AuthorVisibility } from "./sync-contract.js";

export type { AuthorVisibility } from "./sync-contract.js";
import {
  draftCreateRequestSchema,
  draftUpdateRequestSchema,
  Digest,
  parseContractEffect,
  planThreeWaySync,
  normalizeRegistryNamespace,
  normalizeRegistrySkitSlug,
  validateSkitDirectoryEffect,
  walkTreeEffect,
  type SyncFileVersion,
  SkitContractError,
} from "@smolai/skit-core";
import { MissingRequirement } from "../../handlers/failures.js";
import {
  DestinationExistsWithoutHistory,
  DestinationFormInvalid,
  DraftSlugMismatch,
  RegistryMismatch,
  RegistryRejectedWrite,
} from "../../registry/failures.js";
import {
  AuthenticationRequired,
  CredentialLacksScope,
  PrincipalNotAuthorized,
} from "../../registry/failures.js";

/** The Registry could not be reached for a Draft request. */
export class SyncUnreachable extends Data.TaggedError("SyncUnreachable")<{
  origin: string;
  cause: Error;
}> {
  get message() {
    return `Unable to reach Registry ${this.origin}: ${this.cause.message}`;
  }
}

/** A Draft request the Registry answered, with its own words for why it refused. */
export class SyncRejected extends Data.TaggedError("SyncRejected")<{ message: string }> {}

type StoredFile = { digest: Digest; mediaType: string; contentBase64: string };
type SyncBinding = {
  skitId: string;
  revisionId: string;
  bundleDigest: Digest;
  baseFiles: Record<string, StoredFile>;
};
type SyncState = Record<string, SyncBinding>;
const StoredFileSchema = Schema.Struct({
  digest: Digest,
  mediaType: Schema.String,
  contentBase64: Schema.String,
});
const SyncStateDocument = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      skitId: Schema.String,
      revisionId: Schema.String,
      bundleDigest: Digest,
      baseFiles: Schema.Record(Schema.String, StoredFileSchema),
    }),
  ),
);

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

function normalizeRemote(value: Omit<AuthorRemoteHome, "schema">): AuthorRemoteHome {
  const origin = new URL(value.origin).origin;
  if (
    !origin.startsWith("https://") &&
    !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
  )
    throw new InsecureOrigin({ purpose: "author remote" });
  const namespace = normalizeRegistryNamespace(value.namespace);
  const skit = normalizeRegistrySkitSlug(value.skit);
  if (!namespace || !skit) throw new AuthorDestinationInvalid({ form: "bare" });
  return { schema: "skit.remote.v1", origin, namespace, skit };
}

export function parseAuthorDestination(input: string, registryOrigin?: string): AuthorRemoteHome {
  if (input.startsWith("skit://")) {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      throw new DestinationFormInvalid({ form: "canonical" });
    return normalizeRemote({
      origin: `https://${url.host}`,
      namespace: decodeURIComponent(parts[0]),
      skit: decodeURIComponent(parts[1]),
    });
  }
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      throw new AuthorDestinationInvalid({ form: "https" });
    return normalizeRemote({
      origin: url.origin,
      namespace: decodeURIComponent(parts[0]),
      skit: decodeURIComponent(parts[1]),
    });
  }
  const parts = input.split("/");
  if (parts.length !== 2 || !registryOrigin)
    throw registryOrigin
      ? new AuthorDestinationInvalid({ form: "bare" })
      : new DestinationFormInvalid({ form: "relative-without-registry" });
  return normalizeRemote({ origin: registryOrigin, namespace: parts[0], skit: parts[1] });
}

const decodeUrl = (input: string) =>
  Schema.decodeUnknownEffect(Schema.URLFromString)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "Invalid URL" })),
  );

const decodeAuthorSegment = (input: string) =>
  Schema.decodeUnknownEffect(Schema.StringFromUriComponent)(input).pipe(
    Effect.mapError(() => new AuthorDestinationMalformed({ message: "URI malformed" })),
  );

const normalizeRemoteEffect = Effect.fn("Author.normalizeRemote")(function* (
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

export const parseAuthorDestinationEffect = Effect.fn("Author.parseDestination")(function* (
  input: string,
  registryOrigin?: string,
) {
  if (input.startsWith("skit://")) {
    const url = yield* decodeUrl(input);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2 || url.search || url.hash)
      return yield* new DestinationFormInvalid({ form: "canonical" });
    return yield* normalizeRemoteEffect({
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
    return yield* normalizeRemoteEffect({
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
  return yield* normalizeRemoteEffect({
    origin: registryOrigin,
    namespace: parts[0],
    skit: parts[1],
  });
});

export function authorRef(remote: AuthorRemoteHome): string {
  const authority = new URL(remote.origin).host;
  return `skit://${authority}/${remote.namespace}/${remote.skit}`;
}

export function readAuthorRemoteEffect(
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
    const normalized = yield* normalizeRemoteEffect(document).pipe(
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
  yield* fs.writeFileString(temporary, `${JSON.stringify(remote, null, 2)}\n`, { mode: 0o644 });
  yield* fs.rename(temporary, path);
});

function hash(bytes: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function fromBase64(contentBase64: string, mediaType: string): SyncFileVersion {
  const bytes = Buffer.from(contentBase64, "base64");
  return { bytes, digest: hash(bytes), mediaType };
}
function statePath(home?: string) {
  return join(
    resolve(home ?? process.env.SKIT_HOME ?? join(homedir(), ".skit")),
    "sync-bindings.json",
  );
}
const readState = Effect.fn("Sync.readState")(function* (home?: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(statePath(home))
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        isErrno(error, "ENOENT") ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  // The reader classified a malformed file as a defect before this conversion and still does.
  if (text === undefined) return {} as SyncState;
  return (yield* Schema.decodeUnknownEffect(SyncStateDocument)(text).pipe(
    Effect.orDie,
  )) as SyncState;
});
const writeState = Effect.fn("Sync.writeState")(function* (
  home: string | undefined,
  state: SyncState,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = statePath(home);
  yield* fs.makeDirectory(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  yield* fs.writeFileString(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  yield* fs.rename(temporary, path);
});
const readTree = Effect.fn("Sync.readTree")(function* (root: string) {
  const result: Record<string, SyncFileVersion> = {};
  for (const entry of yield* walkTreeEffect(root, "normalized", { respectGitIgnore: true })) {
    if (entry.kind !== "file") continue;
    result[entry.path] = {
      bytes: entry.bytes,
      digest: hash(entry.bytes),
      mediaType: /\.(?:md|txt|json|ya?ml|toml|[cm]?[jt]sx?)$/i.test(entry.path)
        ? "text/plain"
        : "application/octet-stream",
    };
  }
  return result;
});
function serialize(files: Record<string, SyncFileVersion>): Record<string, StoredFile> {
  return Object.fromEntries(
    Object.entries(files).map(([path, file]) => [
      path,
      {
        digest: file.digest,
        mediaType: file.mediaType,
        contentBase64: Buffer.from(file.bytes).toString("base64"),
      },
    ]),
  );
}
function sameFiles(left: Record<string, SyncFileVersion>, right: Record<string, SyncFileVersion>) {
  const paths = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return paths.every((path) => left[path]?.digest === right[path]?.digest);
}
function filesForWire(files: Record<string, SyncFileVersion>) {
  return Object.entries(files).map(([path, file]) => ({
    path,
    content_base64: Buffer.from(file.bytes).toString("base64"),
    media_type: file.mediaType,
  }));
}

export const syncDraftEffect = Effect.fn("Sync.draft")(function* (
  rootInput: string,
  options: {
    apply: boolean;
    home?: string;
    baseUrl?: string;
    token?: string;
    to?: string;
    visibility?: AuthorVisibility;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const root = resolve(rootInput);
  const configuredBase = options.baseUrl ?? process.env.SKIT_SERVER_URL;
  const storedRemote = yield* readAuthorRemoteEffect(root);
  if (storedRemote && options.to)
    return yield* new AuthorRemoteAlreadyExists({ ref: authorRef(storedRemote) });
  if (storedRemote && options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "already-synced" });
  if (!storedRemote && !options.to)
    return yield* new MissingRequirement({
      command: "First author sync",
      requires: "--to <namespace/skit> and --visibility <private|unlisted|public>",
    });
  if (!storedRemote && options.to && !options.visibility)
    return yield* new VisibilityNotAccepted({ reason: "required" });
  const validation = yield* validateSkitDirectoryEffect(root, "draft", {
    assessmentContext: "author",
  });
  if (validation.diagnostics.some((item) => item.severity === "error"))
    return yield* new SyncBlockedByValidation({ stage: "local" });
  const remote =
    storedRemote ??
    (options.to ? yield* parseAuthorDestinationEffect(options.to, configuredBase) : undefined);
  if (!remote) return yield* new NoAuthorRemote();
  const base = remote.origin;
  const owner = remote.namespace;
  const slug = remote.skit;
  const token = options.token ?? process.env.SKIT_TOKEN;
  if (configuredBase && new URL(configuredBase).origin !== base)
    return yield* new RegistryMismatch({
      active: new URL(configuredBase).origin,
      expected: base,
      subject: "author destination",
    });

  const transport = yield* (yield* RegistryHttp).client;
  const client = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient: transport,
    baseUrl: base,
  }).pipe(Effect.provide(authenticatedApiMiddleware(token)));
  const mapAuthorFailure = (context: string, successStatus: number, error: unknown) => {
    if (isRegistryTransportError(error))
      return new SyncUnreachable({ origin: base, cause: error.cause });
    if (Schema.is(UnauthorizedResponse)(error))
      return new AuthenticationRequired({ scopes: "library:sync,authoring:write" });
    if (Schema.is(InsufficientScopeResponse)(error))
      return new CredentialLacksScope({
        scope: "authoring:write",
        scopes: "library:sync,authoring:write",
      });
    if (Schema.is(ForbiddenResponse)(error) || Schema.is(ForbiddenOriginResponse)(error))
      return new PrincipalNotAuthorized({ action: "author this Namespace or SKIT" });
    if (isSuccessfulResponseDecodeFailure(error, [successStatus]))
      return new SkitContractError(`${context} response`, [{ path: "", message: String(error) }]);
    return new SyncRejected({
      message: registryApiFailureMessage(context, error, { defaultStatus: 400 }),
    });
  };

  const local = yield* readTree(root);
  const localDescriptor = validation.descriptor;
  const wireDescriptor = { ...localDescriptor, id: `${owner}/${slug}` };
  const identity = authorRef(remote);
  const read = yield* client.drafts
    .read({ params: { owner, slug } })
    .pipe((effect) => mapRegistryFailureCause(effect, (error) => error), Effect.result);
  if (Result.isFailure(read) && Schema.is(DraftNotFoundResponse)(read.failure)) {
    if (storedRemote) return yield* new RemoteDraftUnavailable({ identity });
    if (!storedRemote && !options.apply)
      return {
        status: "first_sync_ready" as const,
        changed: false,
        identity: {
          authority: remote.origin,
          namespace: remote.namespace,
          skit: remote.skit,
          ref: identity,
        },
        visibility: options.visibility!,
        file_count: Object.keys(local).length,
        effects: ["create_skit", "create_draft", "record_remote_home"] as Array<
          "create_skit" | "create_draft" | "record_remote_home"
        >,
      };
    const created = yield* client.drafts
      .create({
        payload: yield* parseContractEffect("draft create request", draftCreateRequestSchema, {
          owner,
          slug,
          title: slug,
          visibility: options.visibility ?? "private",
          descriptor: wireDescriptor,
          diagnostics: validation.diagnostics,
          files: filesForWire(local),
          source_kind: "local",
        }),
      })
      .pipe((effect) =>
        mapRegistryFailureCause(effect, (error) => mapAuthorFailure("draft create", 201, error)),
      );
    const state = yield* readState(options.home);
    state[identity] = {
      skitId: `${owner}/${slug}`,
      revisionId: created.draft.revision_id,
      bundleDigest: created.draft.bundle_digest,
      baseFiles: serialize(local),
    };
    yield* writeState(options.home, state);
    if (!storedRemote) yield* writeRemote(root, remote);
    return {
      status: "created" as const,
      changed: true,
      identity: {
        authority: remote.origin,
        namespace: remote.namespace,
        skit: remote.skit,
        ref: identity,
      },
      visibility: options.visibility ?? "private",
      revision_id: created.draft.revision_id,
      paths: Object.keys(local).sort(),
      // This field means first sync persisted the repository's remote home.
      remote_home_recorded: !storedRemote,
      published: false,
    };
  }
  if (Result.isFailure(read))
    return yield* Effect.fail(mapAuthorFailure("draft read", 200, read.failure));
  const remoteResponse = read.success;
  if (remoteResponse.draft.descriptor.id !== `${owner}/${slug}`)
    return yield* new RemoteDraftIdentityMismatch();
  if (!storedRemote) return yield* new DestinationExistsWithoutHistory({ identity });
  const remoteFiles = Object.fromEntries(
    remoteResponse.draft.files.map((file) => [
      file.path,
      fromBase64(file.content_base64, file.media_type),
    ]),
  );
  const state = yield* readState(options.home);
  const binding = state[identity];
  if (!binding) {
    if (!sameFiles(local, remoteFiles))
      return { status: "unbound_conflict" as const, changed: false, conflicts: [] };
    state[identity] = {
      skitId: `${owner}/${slug}`,
      revisionId: remoteResponse.draft.revision_id,
      bundleDigest: remoteResponse.draft.bundle_digest,
      baseFiles: serialize(local),
    };
    yield* writeState(options.home, state);
    return {
      status: "bound" as const,
      changed: false,
      revision_id: remoteResponse.draft.revision_id,
    };
  }
  const baseFiles = Object.fromEntries(
    Object.entries(binding.baseFiles).map(([path, file]) => [
      path,
      fromBase64(file.contentBase64, file.mediaType),
    ]),
  );
  const plan = planThreeWaySync(baseFiles, local, remoteFiles);
  if (plan.conflicts.length)
    return { status: "conflicted" as const, changed: false, conflicts: plan.conflicts };
  if (!plan.changedPaths.length)
    return {
      status: "clean" as const,
      changed: false,
      revision_id: remoteResponse.draft.revision_id,
    };
  if (!options.apply)
    return { status: "merge_ready" as const, changed: false, paths: plan.changedPaths };
  if (!sameFiles(yield* readTree(root), local)) return yield* new LocalFilesChangedDuringSync();

  // The staging tree is scoped: an interrupted merge releases it without a `finally`.
  const staging = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "skit-sync-stage-" }),
    (directory) => Effect.orDie(fs.remove(directory, { recursive: true, force: true })),
  );
  for (const [path, file] of Object.entries(plan.files)) {
    const staged = join(staging, ...path.split("/"));
    yield* fs.makeDirectory(dirname(staged), { recursive: true });
    yield* fs.writeFile(staged, file.bytes);
  }
  const mergedValidation = yield* validateSkitDirectoryEffect(staging, "draft", {
    assessmentContext: "author",
  });
  if (mergedValidation.diagnostics.some((item) => item.severity === "error"))
    return yield* new SyncBlockedByValidation({ stage: "merged" });
  if (mergedValidation.descriptor.slug !== localDescriptor.slug)
    return yield* new DraftSlugMismatch({
      context: "Merged",
      remote: mergedValidation.descriptor.slug,
      local: localDescriptor.slug,
    });
  const body = yield* parseContractEffect("draft update request", draftUpdateRequestSchema, {
    title: remoteResponse.draft.title,
    description: remoteResponse.draft.description ?? undefined,
    visibility: remoteResponse.draft.visibility,
    descriptor: { ...mergedValidation.descriptor, id: `${owner}/${slug}` },
    diagnostics: mergedValidation.diagnostics,
    expected_revision_id: remoteResponse.draft.revision_id,
    files: filesForWire(plan.files),
    source_kind: "local",
  });
  const updated = yield* client.drafts.update({ params: { owner, slug }, payload: body }).pipe(
    (effect) => mapRegistryFailureCause(effect, (error) => error),
    Effect.mapError((error) => {
      const failure = mapAuthorFailure("draft update", 200, error);
      return Predicate.isTagged(failure, "SyncRejected")
        ? new RegistryRejectedWrite({ detail: failure.message })
        : failure;
    }),
  );
  // The remote write has happened. Local application follows it and cannot undo it; an
  // interruption here leaves the accepted revision live, exactly as before.
  for (const path of Object.keys(plan.files)) {
    const absolute = join(root, ...path.split("/"));
    yield* fs.makeDirectory(dirname(absolute), { recursive: true });
    yield* fs.rename(join(staging, ...path.split("/")), absolute);
  }
  for (const path of Object.keys(local))
    if (!plan.files[path]) yield* fs.remove(join(root, ...path.split("/")));
  state[identity] = {
    skitId: `${owner}/${slug}`,
    revisionId: updated.draft.revision_id,
    bundleDigest: updated.draft.bundle_digest,
    baseFiles: serialize(plan.files),
  };
  yield* writeState(options.home, state);
  return {
    status: "merged" as const,
    changed: true,
    revision_id: updated.draft.revision_id,
    paths: plan.changedPaths,
  };
});
