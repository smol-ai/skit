import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect";
import type { CloudflareBindings } from "../platform/cloudflare.js";
import {
  Bindings,
  type BlobStorageError,
  blobStorageEffectFrom,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
  r2BodyEffect,
} from "../platform/cloudflare.js";
import { IntegrityError } from "../integrity/contracts.js";
import { validateArtifactBundle } from "../integrity/validate.js";
import { sha256 } from "../integrity/crypto.js";
import {
  Diagnostic,
  type DraftCreateRequest,
  type DraftReadResponse,
  type DraftRevision,
  type DraftUpdateRequest,
  MAX_DRAFT_CONTENT_BYTES,
  WireDescriptor,
} from "./contracts.js";

export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()(
  "Draft.RevisionConflict",
  {},
) {}

export class DraftBlobMissing extends Schema.TaggedError<DraftBlobMissing>()("Draft.BlobMissing", {
  path: Schema.String,
}) {}

export class DraftEncodingError extends Schema.TaggedError<DraftEncodingError>()(
  "Draft.EncodingError",
  { path: Schema.String, cause: Schema.Defect() },
) {}

export class DraftTooLarge extends Schema.TaggedError<DraftTooLarge>()("Draft.TooLarge", {}) {}

export type WriteError =
  | RevisionConflict
  | DraftEncodingError
  | IntegrityError
  | DatabaseError
  | BlobStorageError
  | import("effect/PlatformError").PlatformError;

export interface DraftWriteInput extends DraftUpdateRequest {
  readonly owner: string;
  readonly slug: string;
}

export interface DraftService {
  readonly create: (input: DraftCreateRequest) => Effect.Effect<DraftRevision, WriteError>;
  readonly write: (input: DraftWriteInput) => Effect.Effect<DraftRevision, WriteError>;
  readonly read: (
    owner: string,
    slug: string,
  ) => Effect.Effect<
    DraftReadResponse | undefined,
    DatabaseError | BlobStorageError | DraftBlobMissing | DraftTooLarge
  >;
}

export class Drafts extends Context.Service<Drafts, DraftService>()("@skit-server-effect/Drafts") {}

const CurrentRevision = Schema.Struct({ current_revision_id: Schema.String });
const StoredDraft = Schema.Struct({
  current_revision_id: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  visibility: Schema.Literals(["public", "unlisted", "private"]),
  bundle_digest: Schema.String,
  descriptor_json: Schema.String,
  diagnostics_json: Schema.String,
});
const StoredFile = Schema.Struct({
  path: Schema.String,
  byte_length: Schema.Int,
  media_type: Schema.String,
  executable: Schema.Int,
  object_key: Schema.String,
});
const StoredDiagnostics = Schema.fromJsonString(Schema.Array(Diagnostic));
const StoredDescriptor = Schema.fromJsonString(WireDescriptor);

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const layer = Layer.effect(
  Drafts,
  Effect.gen(function* () {
    const bindings: CloudflareBindings = yield* Bindings;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const crypto = yield* Crypto.Crypto;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blobs = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);
    const write = Effect.fn("Draft.write")(function* (input: DraftWriteInput) {
      const currentRows = yield* db(
        "read current draft revision",
        sql`SELECT current_revision_id FROM drafts
            WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}`,
      );
      const current =
        currentRows[0] === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(CurrentRevision)(currentRows[0]).pipe(
              Effect.mapError(
                (cause) => new DatabaseError({ operation: "decode current draft revision", cause }),
              ),
            );
      if (current?.current_revision_id !== input.expected_revision_id)
        return yield* new RevisionConflict();

      const prepared = yield* Effect.forEach(input.files, (file) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.try({
            try: () =>
              Uint8Array.from(atob(file.content_base64), (character) => character.charCodeAt(0)),
            catch: (cause) => new DraftEncodingError({ path: file.path, cause }),
          });
          const blobDigest = yield* sha256(bytes).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
          );
          return {
            path: file.path,
            bytes,
            digest: blobDigest,
            media_type: file.media_type,
            executable: file.executable ?? false,
            objectKey: `draft-blobs/${blobDigest.slice(7, 9)}/${blobDigest.slice(7)}`,
          };
        }),
      );
      const validated = yield* validateArtifactBundle(
        input.owner,
        input.slug,
        input.descriptor,
        prepared,
      ).pipe(Effect.provideService(Crypto.Crypto, crypto));
      const manifest = prepared
        .map(
          (file) =>
            `${file.path}\0${file.digest}\0${file.bytes.byteLength}\0${file.media_type}\0${file.executable ? 1 : 0}`,
        )
        .sort()
        .join("\n");
      const bundleDigest = yield* sha256(new TextEncoder().encode(manifest)).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const revisionId = `draft_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`;
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();

      for (const file of prepared) {
        const existing = yield* blobs("find draft blob", (bucket) => bucket.head(file.objectKey));
        if (existing === null)
          yield* blobs("write draft blob", (bucket) =>
            bucket.put(file.objectKey, file.bytes, {
              httpMetadata: { contentType: file.media_type },
            }),
          );
      }

      const statements = [
        sql`INSERT INTO drafts
           (owner_slug, skit_slug, title, description, visibility, current_revision_id, created_at, updated_at)
           VALUES (${input.owner}, ${input.slug}, ${input.title}, ${input.description ?? ""}, ${input.visibility}, NULL, ${now}, ${now})
           ON CONFLICT(owner_slug, skit_slug) DO UPDATE SET
             title=excluded.title, description=excluded.description,
             visibility=excluded.visibility, updated_at=excluded.updated_at
           WHERE drafts.current_revision_id IS ${input.expected_revision_id ?? null}`,
        sql`INSERT INTO draft_revisions
           (revision_id, owner_slug, skit_slug, parent_revision_id, bundle_digest,
            descriptor_json, diagnostics_json, created_at)
           SELECT ${revisionId}, ${input.owner}, ${input.slug}, ${input.expected_revision_id ?? null},
                  ${bundleDigest}, ${JSON.stringify(validated.descriptor)},
                  ${JSON.stringify(validated.diagnostics)}, ${now}
           WHERE EXISTS (
             SELECT 1 FROM drafts
             WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}
               AND current_revision_id IS ${input.expected_revision_id ?? null}
           )`,
        ...prepared.map(
          (file) => sql`INSERT INTO draft_files
             (revision_id, path, blob_digest, byte_length, media_type, executable, object_key)
             SELECT ${revisionId}, ${file.path}, ${file.digest}, ${file.bytes.byteLength},
                    ${file.media_type}, ${file.executable ? 1 : 0}, ${file.objectKey}
             WHERE EXISTS (
               SELECT 1 FROM draft_revisions WHERE revision_id = ${revisionId}
             )`,
        ),
        sql`UPDATE drafts SET current_revision_id = ${revisionId}, updated_at = ${now}
            WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}
              AND current_revision_id IS ${input.expected_revision_id ?? null}
            RETURNING owner_slug`,
      ];
      const results = yield* db("commit draft revision", sql.batch(statements));
      if (results.at(-1)?.length !== 1) return yield* new RevisionConflict();
      return {
        skit_id: `${input.owner}/${input.slug}`,
        revision_id: revisionId,
        manifest_digest: yield* sha256(new TextEncoder().encode(manifest)).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        ),
        bundle_digest: bundleDigest,
        files: prepared.map((file) => ({
          path: file.path,
          digest: file.digest,
          bytes: file.bytes.byteLength,
          media_type: file.media_type,
          executable: file.executable,
        })),
        diagnostics: validated.diagnostics,
      };
    });

    const create = Effect.fn("Draft.create")(function* (input: DraftCreateRequest) {
      const owner = input.owner ?? input.descriptor.id.split("/")[0];
      return yield* write({ ...input, owner, slug: input.slug });
    });

    const read = Effect.fn("Draft.read")(function* (owner: string, slug: string) {
      const draftRows = yield* db(
        "read draft",
        sql`SELECT d.current_revision_id, d.title, d.description, d.visibility,
                  r.bundle_digest, r.descriptor_json, r.diagnostics_json
           FROM drafts d JOIN draft_revisions r ON r.revision_id = d.current_revision_id
           WHERE d.owner_slug = ${owner} AND d.skit_slug = ${slug}`,
      );
      if (draftRows[0] === undefined) return undefined;
      const draft = yield* Schema.decodeUnknownEffect(StoredDraft)(draftRows[0]).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation: "decode stored draft", cause })),
      );
      const unknownFiles = yield* db(
        "read draft files",
        sql`SELECT path, byte_length, media_type, executable, object_key FROM draft_files
            WHERE revision_id = ${draft.current_revision_id} ORDER BY path`,
      );
      const storedFiles = yield* Schema.decodeUnknownEffect(Schema.Array(StoredFile))(
        unknownFiles,
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode stored draft files", cause }),
        ),
      );
      if (
        storedFiles.reduce((total, file) => total + file.byte_length, 0) > MAX_DRAFT_CONTENT_BYTES
      )
        return yield* new DraftTooLarge();
      const files = yield* Effect.forEach(storedFiles, (file) =>
        Effect.gen(function* () {
          const object = yield* blobs("read draft blob", (bucket) => bucket.get(file.object_key));
          if (object === null) return yield* new DraftBlobMissing({ path: file.path });
          const content = new Uint8Array(
            yield* r2BodyEffect("read draft blob body", () => object.arrayBuffer()),
          );
          return {
            path: file.path,
            media_type: file.media_type,
            executable: Boolean(file.executable),
            content_base64: encodeBase64(content),
          };
        }),
      );
      const descriptor = yield* Schema.decodeUnknownEffect(StoredDescriptor, {
        onExcessProperty: "preserve",
      })(draft.descriptor_json).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode stored draft descriptor", cause }),
        ),
      );
      const diagnostics = yield* Schema.decodeUnknownEffect(StoredDiagnostics)(
        draft.diagnostics_json,
      ).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode stored draft diagnostics", cause }),
        ),
      );
      return {
        draft: {
          revision_id: draft.current_revision_id,
          bundle_digest: draft.bundle_digest,
          title: draft.title,
          description: draft.description,
          visibility: draft.visibility,
          descriptor,
          diagnostics,
          files,
        },
      };
    });

    return Drafts.of({ create, write, read });
  }),
);
