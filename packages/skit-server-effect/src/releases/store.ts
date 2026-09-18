import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";
import {
  Bindings,
  type CloudflareBindings,
  type BlobStorageError,
  type DatabaseError,
  blobStorageEffectFrom,
  databaseError,
  type DatabaseSqlClient,
} from "../platform/cloudflare.js";

export const ReleaseVisibility = Schema.Literals(["public", "unlisted", "private"]);
export type ReleaseVisibility = typeof ReleaseVisibility.Type;

export const DownloadableRelease = Schema.Struct({
  release_id: Schema.String,
  version: Schema.String,
  archive_object_key: Schema.String,
  visibility: ReleaseVisibility,
});
export interface DownloadableRelease extends Schema.Schema.Type<typeof DownloadableRelease> {}

export class StoredReleaseInvalid extends Schema.TaggedError<StoredReleaseInvalid>()(
  "ReleaseStore.StoredReleaseInvalid",
  { cause: Schema.Defect() },
) {}

export interface ReleaseStoreService {
  readonly findLatestPublic: (input: {
    readonly owner: string;
    readonly slug: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly findAnonymousDownload: (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly findExactDownload: (input: {
    readonly owner: string;
    readonly slug: string;
    readonly version: string;
  }) => Effect.Effect<DownloadableRelease | null, DatabaseError | StoredReleaseInvalid>;
  readonly listLatestDownloads: (input: {
    readonly owner: string;
    readonly slug: string;
  }) => Effect.Effect<ReadonlyArray<DownloadableRelease>, DatabaseError | StoredReleaseInvalid>;
  readonly readArchive: (objectKey: string) => Effect.Effect<R2ObjectBody | null, BlobStorageError>;
}

export class ReleaseStore extends Context.Service<ReleaseStore, ReleaseStoreService>()(
  "@skit-server-effect/ReleaseStore",
) {}

export const layer = Layer.effect(
  ReleaseStore,
  Effect.gen(function* () {
    const bindings: CloudflareBindings = yield* Bindings;
    const sql: DatabaseSqlClient = yield* D1Client.D1Client;
    const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(databaseError(operation));
    const blobs = <A>(operation: string, run: (bucket: R2Bucket) => Promise<A>) =>
      blobStorageEffectFrom(bindings.blobs, operation, run);
    const decodeRelease = (row: unknown) =>
      Schema.decodeUnknownEffect(DownloadableRelease)(row).pipe(
        Effect.mapError((cause) => new StoredReleaseInvalid({ cause })),
      );

    const findAnonymousDownload = Effect.fn("ReleaseStore.findAnonymousDownload")(
      function* (input: {
        readonly owner: string;
        readonly slug: string;
        readonly version: string;
      }) {
        const latest = input.version === "latest";
        const rows = yield* db(
          "find anonymous release download",
          latest
            ? sql`SELECT release_id, version, archive_object_key, visibility FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND visibility IN ('public', 'unlisted') ORDER BY published_at DESC, rowid DESC LIMIT 1`
            : sql`SELECT release_id, version, archive_object_key, visibility FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND version = ${input.version} AND visibility IN ('public', 'unlisted')`,
        );
        return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
      },
    );

    const findLatestPublic = Effect.fn("ReleaseStore.findLatestPublic")(function* (input: {
      readonly owner: string;
      readonly slug: string;
    }) {
      const rows = yield* db(
        "find latest public release",
        sql`SELECT release_id, version, archive_object_key, visibility
          FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND visibility = 'public'
          ORDER BY published_at DESC, rowid DESC LIMIT 1`,
      );
      return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
    });

    const findExactDownload = Effect.fn("ReleaseStore.findExactDownload")(function* (input: {
      readonly owner: string;
      readonly slug: string;
      readonly version: string;
    }) {
      const rows = yield* db(
        "find exact release download",
        sql`SELECT release_id, version, archive_object_key, visibility
          FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug} AND version = ${input.version}`,
      );
      return rows[0] === undefined ? null : yield* decodeRelease(rows[0]);
    });

    const listLatestDownloads = Effect.fn("ReleaseStore.listLatestDownloads")(function* (input: {
      readonly owner: string;
      readonly slug: string;
    }) {
      const rows = yield* db(
        "list release downloads",
        sql`SELECT release_id, version, archive_object_key, visibility
          FROM releases WHERE owner_slug = ${input.owner} AND skit_slug = ${input.slug}
          ORDER BY published_at DESC, rowid DESC`,
      );
      return yield* Effect.forEach(rows, decodeRelease);
    });

    const readArchive = Effect.fn("ReleaseStore.readArchive")((objectKey: string) =>
      blobs("read release archive", (bucket) => bucket.get(objectKey)),
    );

    return ReleaseStore.of({
      findLatestPublic,
      findAnonymousDownload,
      findExactDownload,
      listLatestDownloads,
      readArchive,
    });
  }),
);
