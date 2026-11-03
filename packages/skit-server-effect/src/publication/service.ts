import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { D1Client } from "@effect/sql-d1";
import { Skits } from "../skits/service.js";
import { verifyReleaseArchive } from "./archive.js";
import { type Hash, sha256Hash } from "@smolai/skit-core/universal/consumer";
import { IntegrityError, ValidationDiagnostic } from "../integrity/contracts.js";
import {
  BlobStore,
  type BlobStorageError,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";

const ReleaseRow = Schema.Struct({ release_id: Schema.String });

export class SkitNotFound extends Schema.TaggedError<SkitNotFound>()(
  "Publication.SkitNotFound",
  {},
) {}
export class CurrentRevisionMissing extends Schema.TaggedError<CurrentRevisionMissing>()(
  "Publication.CurrentRevisionMissing",
  {},
) {}
export class StaleRevision extends Schema.TaggedError<StaleRevision>()(
  "Publication.StaleRevision",
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
  readonly archive_digest: Hash;
}

export type PublicationError =
  | SkitNotFound
  | CurrentRevisionMissing
  | StaleRevision
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
    const blobs = yield* BlobStore;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const digests = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const skits = yield* Skits;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
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
      const skit = yield* skits.current(input.owner, input.slug);
      if (skit === undefined) return yield* new SkitNotFound();
      const current = skit.current;
      if (current === null) return yield* new CurrentRevisionMissing();
      if (input.revisionId !== undefined && input.revisionId !== current)
        return yield* new StaleRevision();

      const diagnostics = yield* verifyReleaseArchive(
        input.owner,
        input.slug,
        current,
        input.archive,
      ).pipe(
        Effect.provideService(D1Client.D1Client, sql),
        Effect.provideService(Digest.Digest, digests),
      );
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error"))
        return yield* new PublishBlocked({ diagnostics });

      if ((yield* findRelease(input.owner, input.slug, input.version)) !== undefined)
        return yield* new ReleaseConflict();

      const archiveDigest = yield* sha256Hash(input.archive).pipe(
        Effect.provideService(Digest.Digest, digests),
      );
      const releaseId = `rel_${yield* random.uuidV4()}`;
      const objectKey = `releases/${input.owner}/${input.slug}/${input.version}/${releaseId}.zip`;
      yield* blobs.put("write release archive", objectKey, input.archive, {
        contentType: "application/zip",
      });
      const publishedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const insert = db(
        "insert release",
        sql`INSERT INTO releases
           (owner_slug, skit_slug, version, release_id, source_revision, archive_digest,
            archive_bytes, archive_object_key, published_at, visibility)
           VALUES (${input.owner}, ${input.slug}, ${input.version}, ${releaseId},
                   ${current}, ${archiveDigest}, ${input.archive.byteLength},
                   ${objectKey}, ${publishedAt}, ${skit.visibility})`,
      );
      yield* insert.pipe(
        Effect.catchTag("Cloudflare.DatabaseError", (insertError) =>
          Effect.gen(function* () {
            yield* blobs
              .delete("delete uncommitted release archive", [objectKey])
              .pipe(
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
        revision_id: current,
        archive_digest: archiveDigest,
      };
    });

    return Publication.of({ publish });
  }),
);
