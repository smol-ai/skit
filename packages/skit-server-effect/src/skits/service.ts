import type { Principal } from "../identity/service.js";
import { makeList, type List } from "./internal/list.js";
import { makeNamespaceAccess } from "../identity/namespaces.js";
import { makeReleaseReads, type Releases } from "./internal/releases.js";
import { makePublication, type Publication } from "./internal/publication.js";
import { makeDeletion, type Deletion } from "./internal/deletion.js";
import { D1Client } from "@effect/sql-d1";
import {
  type SkitCurrentResponse,
  History,
  MAX_ARTIFACT_CONTENT_BYTES,
  MAX_ARTIFACT_FILES,
  type RevisionPage,
  type RevisionPostRequest,
  type RevisionPostResponse,
  type RevisionReadResponse,
  skitDescriptorRequestSchema,
  skitValidationDiagnosticsSchema,
} from "@smolai/skit-core/universal/authoring";
import { Hash, safePathSchema, sha256Hash } from "@smolai/skit-core/universal/consumer";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { IntegrityError } from "../integrity/contracts.js";
import {
  readArtifactDescriptor,
  unpublishableEntries,
  validateArtifactBundle,
  validateArtifactFiles,
} from "../integrity/validate.js";
import {
  BlobStore,
  type BlobStorageError,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";

class SkitForbidden extends Schema.TaggedError<SkitForbidden>()("SKIT.Forbidden", {}) {}

class SkitExists extends Schema.TaggedError<SkitExists>()("SKIT.Exists", {}) {}

class SkitNotFound extends Schema.TaggedError<SkitNotFound>()("SKIT.NotFound", {}) {}

/** A revision the SKIT refuses to record or point at. `code` is the wire error. */
class InvalidRevision extends Schema.TaggedError<InvalidRevision>()("SKIT.InvalidRevision", {
  code: Schema.Literals([
    "UNSAFE_PATH",
    "TREE_HASH_MISMATCH",
    "REVISION_ID_MISMATCH",
    "PARENT_MISSING",
    "REVISION_MISSING",
  ]),
}) {}

/** Another device moved `current` first; this is where it points now. */
class CurrentMoved extends Schema.TaggedError<CurrentMoved>()("SKIT.CurrentMoved", {
  current: Schema.NullOr(History.RevisionId),
}) {}

class RevisionBlobMissing extends Schema.TaggedError<RevisionBlobMissing>()("SKIT.BlobMissing", {
  path: Schema.String,
}) {}

class RevisionBlobCorrupt extends Schema.TaggedError<RevisionBlobCorrupt>()("SKIT.BlobCorrupt", {
  path: Schema.String,
}) {}

class RevisionTooLarge extends Schema.TaggedError<RevisionTooLarge>()("SKIT.TooLarge", {}) {}

type PostError = SkitNotFound | InvalidRevision | IntegrityError | DatabaseError | BlobStorageError;

type ReadError =
  | DatabaseError
  | BlobStorageError
  | RevisionBlobMissing
  | RevisionBlobCorrupt
  | RevisionTooLarge;

interface SkitAuthoring {
  /** Create an empty SKIT, or replay its saved creation request without changing it. */
  readonly create: (
    visibility: SkitCurrentResponse["visibility"],
    requestId?: string,
  ) => Effect.Effect<void, SkitExists | DatabaseError | SkitForbidden>;
  readonly current: () => Effect.Effect<
    SkitCurrentResponse | undefined,
    DatabaseError | SkitForbidden
  >;
  /**
   * Record a revision after checking its identity. Recording one the SKIT already holds returns
   * it unchanged. Invalid content is accepted with diagnostics. It never moves `current`.
   */
  readonly post: (
    request: RevisionPostRequest,
  ) => Effect.Effect<RevisionPostResponse, PostError | SkitForbidden>;
  /** Point `current` at `id`, only if it still points at `expected`. */
  readonly move: (
    expected: History.RevisionId | null,
    id: History.RevisionId,
  ) => Effect.Effect<
    void,
    SkitNotFound | InvalidRevision | CurrentMoved | DatabaseError | SkitForbidden
  >;
  readonly revision: (
    id: History.RevisionId,
  ) => Effect.Effect<RevisionReadResponse | undefined, ReadError | SkitForbidden>;
  /**
   * The revisions reachable from `id`, `id` included, newest first. That set never changes, so
   * `offset` is a stable cursor.
   */
  readonly ancestors: (
    id: History.RevisionId,
    limit: number,
    offset: number,
  ) => Effect.Effect<RevisionPage | undefined, DatabaseError | SkitForbidden>;
}

export interface SkitService {
  /** Accessible authored SKITs, filtered and paginated within this owner. */
  readonly list: List;
  /** Selected releases expose archive reads, never blob keys or arbitrary storage access. */
  readonly releases: Releases;
  /** Publish the current revision after checking the complete release archive. */
  readonly preparePublication: Publication["preparePublication"];
  /** Passive deletion facts; no state or archives change. */
  readonly planDelete: Deletion["planDelete"];
  /** Delete private lifecycle state atomically, then clean up release archives. */
  readonly delete: Deletion["delete"];
  /** Authoring authority bound to one caller and target; every operation checks current ownership. */
  readonly prepareAuthoring: (
    principal: Principal,
    target: { readonly owner: string; readonly slug: string },
  ) => Effect.Effect<SkitAuthoring, DatabaseError | SkitForbidden>;
}

export class Skits extends Context.Service<Skits, SkitService>()("@skit-server-effect/Skits") {}

const StoredSkit = Schema.Struct({
  current_revision_id: Schema.NullOr(History.RevisionId),
  visibility: Schema.Literals(["public", "unlisted", "private"]),
});
const StoredRevision = Schema.Struct({
  revision_id: History.RevisionId,
  tree_hash: Schema.String,
  author_device: Schema.String,
  author_at: Schema.Int,
  diagnostics_json: Schema.fromJsonString(skitValidationDiagnosticsSchema),
});
const StoredParent = Schema.Struct({ revision_id: Schema.String, parent_id: Schema.String });
const StoredEntry = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    kind: Schema.Literal("file"),
    mode: Schema.Literals([0o644, 0o755]),
    blob_hash: Hash,
    byte_length: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: MAX_ARTIFACT_CONTENT_BYTES }),
    ),
  }),
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("directory") }),
  Schema.Struct({ path: Schema.String, kind: Schema.Literal("symlink"), target: Schema.String }),
]);

// Keep the existing R2 namespace so the SQL migration does not orphan file bytes.
const blobKey = (hash: string) => `draft-blobs/${hash.slice(7, 9)}/${hash.slice(7)}`;

export const layer = Layer.effect(
  Skits,
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const namespaces = yield* makeNamespaceAccess();
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const digests = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));

    const findSkit = Effect.fn("SKIT.findSkit")(function* (owner: string, slug: string) {
      const rows = yield* db(
        "read skit",
        sql`SELECT current_revision_id, visibility FROM skits
            WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
      );
      if (rows[0] === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(StoredSkit)(rows[0]).pipe(
        databaseError("decode skit"),
      );
    });

    const hasRevision = Effect.fn("SKIT.hasRevision")(function* (
      owner: string,
      slug: string,
      id: History.RevisionId,
    ) {
      const rows = yield* db(
        "find revision",
        sql`SELECT 1 found FROM revisions
            WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND revision_id = ${id}`,
      );
      return rows.length > 0;
    });

    /** Each revision rebuilt from its row and its parents in order. */
    const revisionsOf = Effect.fn("SKIT.revisionsOf")(function* (
      owner: string,
      slug: string,
      rows: ReadonlyArray<unknown>,
    ) {
      const stored = yield* Schema.decodeUnknownEffect(Schema.Array(StoredRevision))(rows).pipe(
        databaseError("decode revisions"),
      );
      const parentRows = yield* db(
        "read revision parents",
        sql`SELECT revision_id, parent_id FROM revision_parents
            WHERE owner_slug = ${owner} AND skit_slug = ${slug}
              AND revision_id IN (SELECT value FROM json_each(${JSON.stringify(
                stored.map(({ revision_id }) => revision_id),
              )}))
            ORDER BY revision_id, position`,
      );
      const parents = yield* Schema.decodeUnknownEffect(Schema.Array(StoredParent))(
        parentRows,
      ).pipe(databaseError("decode revision parents"));
      return yield* Effect.forEach(stored, (row) =>
        Schema.decodeUnknownEffect(History.Revision)({
          tree: row.tree_hash,
          parents: parents
            .filter(({ revision_id }) => revision_id === row.revision_id)
            .map(({ parent_id }) => parent_id),
          author: { device: row.author_device, at: row.author_at },
        }).pipe(
          databaseError("decode revision"),
          Effect.map((revision) => ({
            id: row.revision_id,
            revision,
            diagnostics: row.diagnostics_json,
          })),
        ),
      );
    });

    const create = Effect.fn("SKIT.create")(function* (
      owner: string,
      slug: string,
      visibility: SkitCurrentResponse["visibility"],
      requestId?: string,
    ) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const created = yield* db(
        "create skit",
        sql`INSERT INTO skits (owner_slug, skit_slug, visibility, current_revision_id, created_at, updated_at, creation_request_id)
            VALUES (${owner}, ${slug}, ${visibility}, NULL, ${now}, ${now}, ${requestId ?? null})
            ON CONFLICT (owner_slug, skit_slug) DO NOTHING RETURNING owner_slug`,
      );
      if (created.length > 0) return;
      if (requestId !== undefined) {
        const replay = yield* db(
          "check skit creation request",
          sql`SELECT owner_slug FROM skits
              WHERE owner_slug = ${owner} AND skit_slug = ${slug}
                AND creation_request_id = ${requestId} AND visibility = ${visibility}`,
        );
        if (replay.length > 0) return;
      }
      return yield* new SkitExists();
    });

    const current = Effect.fn("SKIT.current")(function* (owner: string, slug: string) {
      const skit = yield* findSkit(owner, slug);
      if (skit === undefined) return undefined;
      return {
        skit_id: `${owner}/${slug}`,
        current: skit.current_revision_id,
        visibility: skit.visibility,
      };
    });

    const post = Effect.fn("SKIT.post")(
      function* (
        owner: string,
        slug: string,
        { id, revision, tree }: RevisionPostRequest,
        credentialId: string | undefined,
      ) {
        if ((yield* findSkit(owner, slug)) === undefined) return yield* new SkitNotFound();
        if (tree.length > MAX_ARTIFACT_FILES)
          return yield* new IntegrityError({ code: "INVALID_ARTIFACT" });
        if (new Set(tree.map(({ path }) => path)).size !== tree.length)
          return yield* new IntegrityError({ code: "DUPLICATE_FILE_PATH" });
        if (!tree.every(({ path }) => Schema.is(safePathSchema)(path)))
          return yield* new InvalidRevision({ code: "UNSAFE_PATH" });
        const files = yield* Effect.forEach(
          tree.filter((entry) => entry.kind === "file"),
          (entry) =>
            sha256Hash(entry.bytes).pipe(
              Effect.map((digest) => ({
                path: entry.path,
                bytes: entry.bytes,
                digest,
                executable: entry.mode === 0o755,
              })),
            ),
        );
        yield* validateArtifactFiles(files);
        if ((yield* History.treeHash(tree)) !== revision.tree)
          return yield* new InvalidRevision({ code: "TREE_HASH_MISMATCH" });
        if ((yield* History.revisionId(revision)) !== id)
          return yield* new InvalidRevision({ code: "REVISION_ID_MISMATCH" });

        const recorded = yield* db(
          "find recorded revision",
          sql`SELECT diagnostics_json FROM revisions
              WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND revision_id = ${id}`,
        );
        if (recorded[0] !== undefined) {
          const stored = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ diagnostics_json: StoredRevision.fields.diagnostics_json }),
          )(recorded[0]).pipe(databaseError("decode recorded revision"));
          return { id, diagnostics: stored.diagnostics_json };
        }

        const parents = [...new Set(revision.parents)];
        const foundParents = yield* db(
          "find revision parents",
          sql`SELECT revision_id FROM revisions
              WHERE owner_slug = ${owner} AND skit_slug = ${slug}
                AND revision_id IN (SELECT value FROM json_each(${JSON.stringify(parents)}))`,
        );
        if (foundParents.length !== parents.length)
          return yield* new InvalidRevision({ code: "PARENT_MISSING" });

        // A stored tree already has its entries and blobs; only a new one writes them.
        const treeStored =
          (yield* db(
            "find tree",
            sql`SELECT 1 found FROM revision_trees WHERE tree_hash = ${revision.tree}`,
          )).length > 0;
        if (!treeStored)
          for (const [hash, bytes] of new Map(files.map((file) => [file.digest, file.bytes]))) {
            if (!(yield* blobs.exists("find skit blob", blobKey(hash))))
              yield* blobs.put("write skit blob", blobKey(hash), bytes);
          }

        const descriptorResult = yield* readArtifactDescriptor(owner, slug, files).pipe(
          Effect.result,
        );
        const descriptor = descriptorResult._tag === "Success" ? descriptorResult.success : null;
        const validated = yield* (
          descriptorResult._tag === "Failure"
            ? Effect.fail(descriptorResult.failure)
            : validateArtifactBundle(owner, slug, descriptorResult.success, files)
        ).pipe(
          Effect.map(({ diagnostics }) => diagnostics),
          Effect.catchTag("Integrity.Error", (error) =>
            Effect.succeed([
              {
                code: error.code,
                severity: "error" as const,
                message: error.detail ?? `Authored content is invalid: ${error.code}`,
              },
            ]),
          ),
        );
        const diagnostics = [...validated, ...unpublishableEntries(tree)];

        const hashes = new Map(files.map((file) => [file.path, file.digest]));
        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        // Every key is content-addressed, so a concurrent identical post changes nothing.
        yield* db(
          "record revision",
          sql.batch([
            ...(treeStored
              ? []
              : [
                  sql`INSERT INTO revision_trees (tree_hash) VALUES (${revision.tree})
                      ON CONFLICT DO NOTHING`,
                  ...tree.map(
                    (entry) =>
                      sql`INSERT INTO revision_tree_entries
                          (tree_hash, path, kind, mode, blob_hash, byte_length, target)
                          VALUES (${revision.tree}, ${entry.path}, ${entry.kind},
                            ${entry.kind === "file" ? entry.mode : null},
                            ${hashes.get(entry.path) ?? null},
                            ${entry.kind === "file" ? entry.bytes.byteLength : null},
                            ${entry.kind === "symlink" ? entry.target : null})
                          ON CONFLICT DO NOTHING`,
                  ),
                ]),
            sql`INSERT INTO revisions
                (owner_slug, skit_slug, revision_id, tree_hash, author_device, author_at,
                 descriptor_json, diagnostics_json, credential_id, created_at)
                VALUES (${owner}, ${slug}, ${id}, ${revision.tree}, ${revision.author.device},
                  ${revision.author.at}, ${JSON.stringify(descriptor)},
                  ${JSON.stringify(diagnostics)}, ${credentialId ?? null}, ${now})
                ON CONFLICT DO NOTHING`,
            ...revision.parents.map(
              (parent, position) =>
                sql`INSERT INTO revision_parents
                    (owner_slug, skit_slug, revision_id, position, parent_id)
                    VALUES (${owner}, ${slug}, ${id}, ${position}, ${parent})
                    ON CONFLICT DO NOTHING`,
            ),
          ]),
        );
        return { id, diagnostics };
      },
      Effect.provideService(Digest.Digest, digests),
    );

    const move = Effect.fn("SKIT.move")(function* (
      owner: string,
      slug: string,
      expected: History.RevisionId | null,
      id: History.RevisionId,
    ) {
      if (!(yield* hasRevision(owner, slug, id)))
        return yield* (yield* findSkit(owner, slug)) === undefined
          ? new SkitNotFound()
          : new InvalidRevision({ code: "REVISION_MISSING" });
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const moved = yield* db(
        "move current revision",
        sql`UPDATE skits SET current_revision_id = ${id}, updated_at = ${now}
            WHERE owner_slug = ${owner} AND skit_slug = ${slug}
              AND current_revision_id IS ${expected}
            RETURNING owner_slug`,
      );
      if (moved.length === 1) return;
      const skit = yield* findSkit(owner, slug);
      if (skit === undefined) return yield* new SkitNotFound();
      return yield* new CurrentMoved({ current: skit.current_revision_id });
    });

    const revision = Effect.fn("SKIT.revision")(
      function* (owner: string, slug: string, id: History.RevisionId) {
        const rows = yield* db(
          "read revision",
          sql`SELECT revision_id, tree_hash, author_device, author_at, diagnostics_json,
                descriptor_json
              FROM revisions
              WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND revision_id = ${id}`,
        );
        if (rows[0] === undefined) return undefined;
        const [read] = yield* revisionsOf(owner, slug, rows);
        if (read === undefined) return undefined;
        const { descriptor_json: descriptor } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            descriptor_json: Schema.fromJsonString(Schema.NullOr(skitDescriptorRequestSchema)),
          }),
        )(rows[0]).pipe(databaseError("decode revision descriptor"));
        const entries = yield* Schema.decodeUnknownEffect(Schema.Array(StoredEntry))(
          yield* db(
            "read tree entries",
            sql`SELECT path, kind, mode, blob_hash, byte_length, target
                FROM revision_tree_entries WHERE tree_hash = ${read.revision.tree}`,
          ),
        ).pipe(databaseError("decode tree entries"));
        if (
          entries.reduce(
            (total, entry) => total + (entry.kind === "file" ? entry.byte_length : 0),
            0,
          ) > MAX_ARTIFACT_CONTENT_BYTES
        )
          return yield* new RevisionTooLarge();
        const tree = yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind !== "file") return entry;
            const object = yield* blobs.get("read skit blob", blobKey(entry.blob_hash));
            if (Option.isNone(object)) return yield* new RevisionBlobMissing({ path: entry.path });
            const bytes = object.value;
            if (
              bytes.byteLength !== entry.byte_length ||
              (yield* sha256Hash(bytes)) !== entry.blob_hash
            )
              return yield* new RevisionBlobCorrupt({ path: entry.path });
            return { path: entry.path, kind: entry.kind, mode: entry.mode, bytes };
          }),
        );
        return {
          revision: read.revision,
          tree: History.sortTree(tree),
          diagnostics: read.diagnostics,
          descriptor,
        };
      },
      Effect.provideService(Digest.Digest, digests),
    );

    const ancestors = Effect.fn("SKIT.ancestors")(function* (
      owner: string,
      slug: string,
      id: History.RevisionId,
      limit: number,
      offset: number,
    ) {
      if (!(yield* hasRevision(owner, slug, id))) return undefined;
      // UNION, not UNION ALL: a revision reached through both sides of a merge is listed once.
      const rows = yield* db(
        "read ancestors",
        sql`WITH RECURSIVE reachable(revision_id) AS (
              SELECT ${id}
              UNION
              SELECT p.parent_id FROM revision_parents p
                JOIN reachable r ON p.revision_id = r.revision_id
                WHERE p.owner_slug = ${owner} AND p.skit_slug = ${slug}
            )
            SELECT d.revision_id, d.tree_hash, d.author_device, d.author_at, d.diagnostics_json
            FROM revisions d JOIN reachable USING (revision_id)
            WHERE d.owner_slug = ${owner} AND d.skit_slug = ${slug}
            ORDER BY d.author_at DESC, d.revision_id DESC
            LIMIT ${limit + 1} OFFSET ${offset}`,
      );
      const revisions = yield* revisionsOf(owner, slug, rows.slice(0, limit));
      return {
        revisions,
        next_cursor: rows.length > limit ? String(offset + limit) : null,
      };
    });

    const prepareAuthoring = Effect.fn("SKIT.prepareAuthoring")(function* (
      principal: Principal,
      target: { readonly owner: string; readonly slug: string },
    ) {
      const { owner, slug } = target;
      const credentialId = principal.tokenId;
      const requireOwner = namespaces
        .ownsNamespace(principal, owner)
        .pipe(
          Effect.flatMap((allowed) => (allowed ? Effect.void : Effect.fail(new SkitForbidden()))),
        );
      yield* requireOwner;
      return {
        create: (visibility, requestId) =>
          requireOwner.pipe(Effect.andThen(create(owner, slug, visibility, requestId))),
        current: () => requireOwner.pipe(Effect.andThen(current(owner, slug))),
        post: (request) =>
          requireOwner.pipe(Effect.andThen(post(owner, slug, request, credentialId))),
        move: (expected, id) => requireOwner.pipe(Effect.andThen(move(owner, slug, expected, id))),
        revision: (id) => requireOwner.pipe(Effect.andThen(revision(owner, slug, id))),
        ancestors: (id, limit, offset) =>
          requireOwner.pipe(Effect.andThen(ancestors(owner, slug, id, limit, offset))),
      } satisfies SkitAuthoring;
    });

    return Skits.of({
      prepareAuthoring,
      list: makeList(sql, namespaces.ownedNamespaces),
      releases: makeReleaseReads(sql, blobs, namespaces.ownsNamespace),
      ...makeDeletion(sql, blobs, namespaces.ownsNamespace),
      ...makePublication(sql, blobs, digests, random, current, namespaces.ownsNamespace),
    });
  }),
);
