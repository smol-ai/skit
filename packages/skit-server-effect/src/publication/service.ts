import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import { verifyReleaseArchive } from "./archive.js";
import { type Digest, IntegrityError, ValidationDiagnostic } from "../integrity/contracts.js";
import { sha256 } from "../integrity/crypto.js";
import {
  Bindings,
  type BlobStorageError,
  type CloudflareBindings,
  DatabaseError,
  blobStorageEffectFrom,
  databaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";

const DraftRow = Schema.Struct({
  current_revision_id: Schema.String,
  visibility: Schema.Literals(["public", "unlisted", "private"]),
});
const ReleaseRow = Schema.Struct({ release_id: Schema.String });

export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()(
  "Publication.DraftNotFound",
  {},
) {}
export class StaleDraftRevision extends Schema.TaggedError<StaleDraftRevision>()(
  "Publication.StaleDraftRevision",
  {},
) {}
export class PublishBlocked extends Schema.TaggedError<PublishBlocked>()(
  "Publication.PublishBlocked",
  { diagnostics: Schema.Array(ValidationDiagnostic) },
) {}
export class ReleaseConflict extends Schema.TaggedError<ReleaseConflict>()(
  "Publication.ReleaseConflict",
  {},
) {}

export interface PublicationInput {
  readonly owner: string;
  readonly slug: string;
  readonly version: string;
  readonly revisionId?: string;
  readonly archive: Uint8Array;
}

export interface PublicationResult {
  readonly release_id: string;
  readonly version: string;
  readonly revision_id: string;
  readonly archive_digest: Digest;
}

export type PublicationError =
  | DraftNotFound
  | StaleDraftRevision
  | PublishBlocked
  | ReleaseConflict
  | IntegrityError
  | DatabaseError
  | BlobStorageError
  | import("effect/PlatformError").PlatformError;

export interface PublicationService {
  readonly publish: (input: PublicationInput) => Effect.Effect<PublicationResult, PublicationError>;
}

export class Publication extends Context.Service<Publication, PublicationService>()(
  "@skit-server-effect/Publication",
) {}

export const layer = Layer.effect(
  Publication,
  Effect.gen(function* () {
    const bindings: CloudflareBindings = yield* Bindings;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const crypto = yield* Crypto.Crypto;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blobs = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);
    const decodeDraft = (value: unknown) =>
      Schema.decodeUnknownEffect(DraftRow)(value).pipe(
        Effect.mapError(
          (cause) => new DatabaseError({ operation: "decode publication draft", cause }),
        ),
      );

    const findRelease = Effect.fn("Publication.findRelease")(function* (
      owner: string,
      slug: string,
      version: string,
    ) {
      const rows = yield* db(
        "find release",
        sql`SELECT release_id FROM releases
            WHERE owner_slug = ${owner} AND skit_slug = ${slug} AND version = ${version}`,
      );
      if (rows[0] === undefined) return undefined;
      return yield* Schema.decodeUnknownEffect(ReleaseRow)(rows[0]).pipe(
        Effect.mapError((cause) => new DatabaseError({ operation: "decode release", cause })),
      );
    });

    const publish = Effect.fn("Publication.publish")(function* (input: PublicationInput) {
      const draftRows = yield* db(
        "find publication draft",
        sql`SELECT current_revision_id, visibility FROM drafts
            WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}`,
      );
      if (draftRows[0] === undefined) return yield* new DraftNotFound();
      const draft = yield* decodeDraft(draftRows[0]);
      if (input.revisionId !== undefined && input.revisionId !== draft.current_revision_id)
        return yield* new StaleDraftRevision();

      const diagnostics = yield* verifyReleaseArchive(
        draft.current_revision_id,
        input.archive,
      ).pipe(
        Effect.provideService(Bindings, bindings),
        Effect.provideService(D1Client.D1Client, sql),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        return yield* new PublishBlocked({ diagnostics });

      if ((yield* findRelease(input.owner, input.slug, input.version)) !== undefined)
        return yield* new ReleaseConflict();

      const archiveDigest = yield* sha256(input.archive).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const releaseId = `rel_${yield* crypto.randomUUIDv4}`;
      const objectKey = `releases/${input.owner}/${input.slug}/${input.version}/${releaseId}.zip`;
      yield* blobs("write release archive", (bucket) =>
        bucket.put(objectKey, input.archive, {
          httpMetadata: { contentType: "application/zip" },
        }),
      );
      const publishedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const insert = db(
        "insert release",
        sql`INSERT INTO releases
           (owner_slug, skit_slug, version, release_id, source_revision, archive_digest,
            archive_bytes, archive_object_key, published_at, visibility)
           VALUES (${input.owner}, ${input.slug}, ${input.version}, ${releaseId},
                   ${draft.current_revision_id}, ${archiveDigest}, ${input.archive.byteLength},
                   ${objectKey}, ${publishedAt}, ${draft.visibility})`,
      );
      yield* insert.pipe(
        Effect.catchTag("Cloudflare.DatabaseError", (insertError) =>
          Effect.gen(function* () {
            yield* blobs("delete uncommitted release archive", (bucket) =>
              bucket.delete(objectKey),
            ).pipe(
              Effect.catch((cleanupError) =>
                Effect.logError("release archive cleanup failed", cleanupError),
              ),
            );
            const raced = yield* findRelease(input.owner, input.slug, input.version).pipe(
              Effect.catch((lookupError) =>
                Effect.logError("release conflict lookup failed", lookupError).pipe(
                  Effect.andThen(Effect.fail(insertError)),
                ),
              ),
            );
            if (raced !== undefined) return yield* new ReleaseConflict();
            return yield* insertError;
          }),
        ),
      );

      return {
        release_id: releaseId,
        version: input.version,
        revision_id: draft.current_revision_id,
        archive_digest: archiveDigest,
      };
    });

    return Publication.of({ publish });
  }),
);
