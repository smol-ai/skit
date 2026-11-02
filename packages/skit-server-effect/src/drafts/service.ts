import { D1Client } from "@effect/sql-d1";
import {
  type DraftCurrentResponse,
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
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Digest } from "effect/crypto";
import { IntegrityError } from "../integrity/contracts.js";
import {
  readArtifactDescriptor,
  unpublishableEntries,
  validateArtifactBundle,
  validateArtifactFiles,
} from "../integrity/validate.js";
import {
  Bindings,
  type BlobStorageError,
  blobStorageEffectFrom,
  type CloudflareBindings,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
  r2Body,
} from "../platform/cloudflare.js";

export class DraftExists extends Schema.TaggedError<DraftExists>()("Draft.Exists", {}) {}

export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()("Draft.NotFound", {}) {}

/** A revision the Draft refuses to record or point at. `code` is the wire error. */
export class InvalidRevision extends Schema.TaggedError<InvalidRevision>()(
  "Draft.InvalidRevision",
  {
    code: Schema.Literals([
      "UNSAFE_PATH",
      "TREE_HASH_MISMATCH",
      "REVISION_ID_MISMATCH",
      "PARENT_MISSING",
      "REVISION_MISSING",
    ]),
  },
) {}

/** Another device moved `current` first; this is where it points now. */
export class CurrentMoved extends Schema.TaggedError<CurrentMoved>()("Draft.CurrentMoved", {
  current: Schema.NullOr(History.RevisionId),
}) {}

export class DraftBlobMissing extends Schema.TaggedError<DraftBlobMissing>()("Draft.BlobMissing", {
  path: Schema.String,
}) {}

export class DraftBlobCorrupt extends Schema.TaggedError<DraftBlobCorrupt>()("Draft.BlobCorrupt", {
  path: Schema.String,
}) {}

export class DraftTooLarge extends Schema.TaggedError<DraftTooLarge>()("Draft.TooLarge", {}) {}

export type PostError =
  | DraftNotFound
  | InvalidRevision
  | IntegrityError
  | DatabaseError
  | BlobStorageError;

export type ReadError =
  | DatabaseError
  | BlobStorageError
  | DraftBlobMissing
  | DraftBlobCorrupt
  | DraftTooLarge;

export interface DraftService {
  /** Create an empty Draft; its `current` stays null until a device moves it. */
  readonly create: (
    owner: string,
    slug: string,
    visibility: DraftCurrentResponse["visibility"],
  ) => Effect.Effect<void, DraftExists | DatabaseError>;
  readonly current: (
    owner: string,
    slug: string,
  ) => Effect.Effect<DraftCurrentResponse | undefined, DatabaseError>;
  /**
   * Record a revision after checking its identity. Recording one the Draft already holds returns
   * it unchanged. Invalid content is accepted with diagnostics. It never moves `current`.
   */
  readonly post: (
    owner: string,
    slug: string,
    request: RevisionPostRequest,
    credentialId: string | undefined,
  ) => Effect.Effect<RevisionPostResponse, PostError>;
  /** Point `current` at `id`, only if it still points at `expected`. */
  readonly move: (
    owner: string,
    slug: string,
    expected: History.RevisionId | null,
    id: History.RevisionId,
  ) => Effect.Effect<void, DraftNotFound | InvalidRevision | CurrentMoved | DatabaseError>;
  readonly revision: (
    owner: string,
    slug: string,
    id: History.RevisionId,
  ) => Effect.Effect<RevisionReadResponse | undefined, ReadError>;
  /**
   * The revisions reachable from `id`, `id` included, newest first. That set never changes, so
   * `offset` is a stable cursor.
   */
  readonly ancestors: (
    owner: string,
    slug: string,
    id: History.RevisionId,
    limit: number,
    offset: number,
  ) => Effect.Effect<RevisionPage | undefined, DatabaseError>;
}

export class Drafts extends Context.Service<Drafts, DraftService>()("@skit-server-effect/Drafts") {}

const StoredDraft = Schema.Struct({
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

const blobKey = (hash: string) => `draft-blobs/${hash.slice(7, 9)}/${hash.slice(7)}`;

export const layer = Layer.effect(
  Drafts,
  Effect.gen(function* () {
    const bindings: CloudflareBindings = yield* Bindings;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const digests = yield* Digest.Digest;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blobs = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);

    const findDraft = Effect.fn("Draft.findDraft")(function* (owner: string, slug: string) {
      const rows = yield* db(
        "read draft",
        sql`SELECT current_revision_id, visibility FROM drafts
            WHERE owner_slug = ${owner} AND skit_slug = ${slug}`,
      );
      if (rows[0] === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(StoredDraft)(rows[0]).pipe(
        databaseError("decode draft"),
      );
    });

    const hasRevision = Effect.fn("Draft.hasRevision")(function* (
      owner: string,
      slug: string,
      id: History.RevisionId,
    ) {
      const rows = yield* db(
        "find revision",
        sql`SELECT 1 found FROM draft_revisions
            WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND revision_id = ${id}`,
      );
      return rows.length > 0;
    });

    /** Each revision rebuilt from its row and its parents in order. */
    const revisionsOf = Effect.fn("Draft.revisionsOf")(function* (
      owner: string,
      slug: string,
      rows: ReadonlyArray<unknown>,
    ) {
      const stored = yield* Schema.decodeUnknownEffect(Schema.Array(StoredRevision))(rows).pipe(
        databaseError("decode revisions"),
      );
      const parentRows = yield* db(
        "read revision parents",
        sql`SELECT revision_id, parent_id FROM draft_revision_parents
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

    const create = Effect.fn("Draft.create")(function* (
      owner: string,
      slug: string,
      visibility: DraftCurrentResponse["visibility"],
    ) {
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const created = yield* db(
        "create draft",
        sql`INSERT INTO drafts (owner_slug, skit_slug, visibility, current_revision_id, created_at, updated_at)
            VALUES (${owner}, ${slug}, ${visibility}, NULL, ${now}, ${now})
            ON CONFLICT (owner_slug, skit_slug) DO NOTHING RETURNING owner_slug`,
      );
      if (created.length === 0) return yield* new DraftExists();
    });

    const current = Effect.fn("Draft.current")(function* (owner: string, slug: string) {
      const draft = yield* findDraft(owner, slug);
      if (draft === undefined) return undefined;
      return {
        skit_id: `${owner}/${slug}`,
        current: draft.current_revision_id,
        visibility: draft.visibility,
      };
    });

    const post = Effect.fn("Draft.post")(
      function* (
        owner: string,
        slug: string,
        { id, revision, tree }: RevisionPostRequest,
        credentialId: string | undefined,
      ) {
        if ((yield* findDraft(owner, slug)) === undefined) return yield* new DraftNotFound();
        if (tree.length > MAX_ARTIFACT_FILES)
          return yield* new IntegrityError({ code: "INVALID_DRAFT" });
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
          sql`SELECT diagnostics_json FROM draft_revisions
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
          sql`SELECT revision_id FROM draft_revisions
              WHERE owner_slug = ${owner} AND skit_slug = ${slug}
                AND revision_id IN (SELECT value FROM json_each(${JSON.stringify(parents)}))`,
        );
        if (foundParents.length !== parents.length)
          return yield* new InvalidRevision({ code: "PARENT_MISSING" });

        // A stored tree already has its entries and blobs; only a new one writes them.
        const treeStored =
          (yield* db(
            "find tree",
            sql`SELECT 1 found FROM draft_trees WHERE tree_hash = ${revision.tree}`,
          )).length > 0;
        if (!treeStored)
          for (const [hash, bytes] of new Map(files.map((file) => [file.digest, file.bytes]))) {
            const existing = yield* blobs("find draft blob", (bucket) =>
              bucket.head(blobKey(hash)),
            );
            if (existing === null)
              yield* blobs("write draft blob", (bucket) => bucket.put(blobKey(hash), bytes));
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
                  sql`INSERT INTO draft_trees (tree_hash) VALUES (${revision.tree})
                      ON CONFLICT DO NOTHING`,
                  ...tree.map(
                    (entry) =>
                      sql`INSERT INTO draft_tree_entries
                          (tree_hash, path, kind, mode, blob_hash, byte_length, target)
                          VALUES (${revision.tree}, ${entry.path}, ${entry.kind},
                            ${entry.kind === "file" ? entry.mode : null},
                            ${hashes.get(entry.path) ?? null},
                            ${entry.kind === "file" ? entry.bytes.byteLength : null},
                            ${entry.kind === "symlink" ? entry.target : null})
                          ON CONFLICT DO NOTHING`,
                  ),
                ]),
            sql`INSERT INTO draft_revisions
                (owner_slug, skit_slug, revision_id, tree_hash, author_device, author_at,
                 descriptor_json, diagnostics_json, credential_id, created_at)
                VALUES (${owner}, ${slug}, ${id}, ${revision.tree}, ${revision.author.device},
                  ${revision.author.at}, ${JSON.stringify(descriptor)},
                  ${JSON.stringify(diagnostics)}, ${credentialId ?? null}, ${now})
                ON CONFLICT DO NOTHING`,
            ...revision.parents.map(
              (parent, position) =>
                sql`INSERT INTO draft_revision_parents
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

    const move = Effect.fn("Draft.move")(function* (
      owner: string,
      slug: string,
      expected: History.RevisionId | null,
      id: History.RevisionId,
    ) {
      if (!(yield* hasRevision(owner, slug, id)))
        return yield* (yield* findDraft(owner, slug)) === undefined
          ? new DraftNotFound()
          : new InvalidRevision({ code: "REVISION_MISSING" });
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      const moved = yield* db(
        "move current revision",
        sql`UPDATE drafts SET current_revision_id = ${id}, updated_at = ${now}
            WHERE owner_slug = ${owner} AND skit_slug = ${slug}
              AND current_revision_id IS ${expected}
            RETURNING owner_slug`,
      );
      if (moved.length === 1) return;
      const draft = yield* findDraft(owner, slug);
      if (draft === undefined) return yield* new DraftNotFound();
      return yield* new CurrentMoved({ current: draft.current_revision_id });
    });

    const revision = Effect.fn("Draft.revision")(
      function* (owner: string, slug: string, id: History.RevisionId) {
        const rows = yield* db(
          "read revision",
          sql`SELECT revision_id, tree_hash, author_device, author_at, diagnostics_json,
                descriptor_json
              FROM draft_revisions
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
                FROM draft_tree_entries WHERE tree_hash = ${read.revision.tree}`,
          ),
        ).pipe(databaseError("decode tree entries"));
        if (
          entries.reduce(
            (total, entry) => total + (entry.kind === "file" ? entry.byte_length : 0),
            0,
          ) > MAX_ARTIFACT_CONTENT_BYTES
        )
          return yield* new DraftTooLarge();
        const tree = yield* Effect.forEach(entries, (entry) =>
          Effect.gen(function* () {
            if (entry.kind !== "file") return entry;
            const object = yield* blobs("read draft blob", (bucket) =>
              bucket.get(blobKey(entry.blob_hash)),
            );
            if (object === null) return yield* new DraftBlobMissing({ path: entry.path });
            if (object.size !== entry.byte_length)
              return yield* new DraftBlobCorrupt({ path: entry.path });
            const bytes = new Uint8Array(
              yield* r2Body("read draft blob body", () => object.arrayBuffer()),
            );
            if (
              bytes.byteLength !== entry.byte_length ||
              (yield* sha256Hash(bytes)) !== entry.blob_hash
            )
              return yield* new DraftBlobCorrupt({ path: entry.path });
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

    const ancestors = Effect.fn("Draft.ancestors")(function* (
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
              SELECT p.parent_id FROM draft_revision_parents p
                JOIN reachable r ON p.revision_id = r.revision_id
                WHERE p.owner_slug = ${owner} AND p.skit_slug = ${slug}
            )
            SELECT d.revision_id, d.tree_hash, d.author_device, d.author_at, d.diagnostics_json
            FROM draft_revisions d JOIN reachable USING (revision_id)
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

    return Drafts.of({ create, current, post, move, revision, ancestors });
  }),
);
