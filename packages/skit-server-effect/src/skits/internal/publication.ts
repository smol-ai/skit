import { Clock, Effect, Schema } from "effect";
import { D1Client } from "@effect/sql-d1";
import { Digest, SecureRandom } from "effect/crypto";
import type { Principal } from "../../identity/service.js";
import type { SkitCurrentResponse } from "@smolai/skit-core/universal/authoring";
import { verifyReleaseArchive } from "./release-archive.js";
import { type Hash, sha256Hash } from "@smolai/skit-core/universal/consumer";
import { IntegrityError, ValidationDiagnostic } from "./integrity/contracts.js";
import {
  type BlobStoreService,
  type BlobStorageError,
  DatabaseError,
  databaseError,
  type DatabaseSqlClient,
} from "../../platform/cloudflare.js";

class PublicationForbidden extends Schema.TaggedError<
  PublicationForbidden,
  { readonly brand: unique symbol }
>()("Publication.Forbidden", {}) {}

const ReleaseRow = Schema.Struct({ release_id: Schema.String });

class SkitNotFound extends Schema.TaggedError<SkitNotFound, { readonly brand: unique symbol }>()(
  "Publication.SkitNotFound",
  {},
) {}
class CurrentRevisionMissing extends Schema.TaggedError<
  CurrentRevisionMissing,
  { readonly brand: unique symbol }
>()("Publication.CurrentRevisionMissing", {}) {}
class StaleRevision extends Schema.TaggedError<StaleRevision, { readonly brand: unique symbol }>()(
  "Publication.StaleRevision",
  {},
) {}
class PublishBlocked extends Schema.TaggedError<
  PublishBlocked,
  { readonly brand: unique symbol }
>()("Publication.PublishBlocked", {
  diagnostics: Schema.Array(ValidationDiagnostic),
}) {}
export class ReleaseConflict extends Schema.TaggedError<
  ReleaseConflict,
  { readonly brand: unique symbol }
>()("Publication.ReleaseConflict", {}) {}

interface PublicationInput {
  readonly owner: string;
  readonly slug: string;
  readonly version: string;
  readonly revisionId?: string;
  readonly archive: Uint8Array;
}

interface PublicationResult {
  readonly release_id: string;
  readonly version: string;
  readonly revision_id: string;
  readonly archive_digest: Hash;
}

type PublicationError =
  | PublicationForbidden
  | SkitNotFound
  | CurrentRevisionMissing
  | StaleRevision
  | PublishBlocked
  | ReleaseConflict
  | IntegrityError
  | DatabaseError
  | BlobStorageError
  | import("effect/PlatformError").PlatformError;

interface PreparedPublication {
  readonly publish: (
    input: Omit<PublicationInput, "owner" | "slug">,
  ) => Effect.Effect<PublicationResult, PublicationError>;
}
export interface Publication {
  readonly preparePublication: (
    principal: Principal,
    target: { readonly owner: string; readonly slug: string },
  ) => Effect.Effect<PreparedPublication, DatabaseError | PublicationForbidden>;
}

/** Publication is constructed only by Skits, using its lifecycle storage and current revision. */
export const makePublication = (
  sql: DatabaseSqlClient,
  blobs: BlobStoreService,
  digests: Digest.Digest["Service"],
  random: SecureRandom.SecureRandom["Service"],
  currentSkit: (
    owner: string,
    slug: string,
  ) => Effect.Effect<SkitCurrentResponse | undefined, DatabaseError>,
  ownsNamespace: (principal: Principal, namespace: string) => Effect.Effect<boolean, DatabaseError>,
): Publication => {
  const db = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
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

  const requireOwner = Effect.fn("Publication.requireOwner")(function* (
    principal: Principal,
    owner: string,
  ) {
    if (!(yield* ownsNamespace(principal, owner))) return yield* new PublicationForbidden();
  });
  const publish = Effect.fn("Publication.publish")(function* (
    principal: Principal,
    input: PublicationInput,
  ) {
    yield* requireOwner(principal, input.owner);
    const skit = yield* currentSkit(input.owner, input.slug);
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
         SELECT ${input.owner}, ${input.slug}, ${input.version}, ${releaseId},
                 ${current}, ${archiveDigest}, ${input.archive.byteLength},
                 ${objectKey}, ${publishedAt}, ${skit.visibility}
         FROM skits WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}
           AND current_revision_id = ${current} AND visibility = ${skit.visibility}
         RETURNING release_id`,
    );
    const cleanup = blobs
      .delete("delete uncommitted release archive", [objectKey])
      .pipe(
        Effect.catch((cleanupError) =>
          Effect.logError("release archive cleanup failed", cleanupError),
        ),
      );
    yield* insert.pipe(
      Effect.flatMap((rows) =>
        rows.length === 1 ? Effect.void : Effect.fail(new StaleRevision()),
      ),
      Effect.catchTags({
        "Publication.StaleRevision": (error) => cleanup.pipe(Effect.andThen(Effect.fail(error))),
        "Cloudflare.DatabaseError": (insertError) =>
          Effect.gen(function* () {
            yield* cleanup;
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
      }),
    );

    return {
      release_id: releaseId,
      version: input.version,
      revision_id: current,
      archive_digest: archiveDigest,
    };
  });

  const preparePublication = Effect.fn("Publication.preparePublication")(function* (
    principal: Principal,
    target: { readonly owner: string; readonly slug: string },
  ) {
    const { owner, slug } = target;
    yield* requireOwner(principal, owner);
    return {
      publish: (input: Omit<PublicationInput, "owner" | "slug">) =>
        publish(principal, { ...input, owner, slug }),
    };
  });
  return { preparePublication };
};
