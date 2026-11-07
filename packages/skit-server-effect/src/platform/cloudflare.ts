import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Option, Schema } from "effect";

export type DatabaseSqlClient = D1Client.D1Client;

export type RuntimeEnv = Omit<
  Env,
  "ACCOUNT_REGISTRATION_MODE" | "ASSETS" | "FEEDBACK_MODE" | "PUBLIC_APP_ORIGIN"
> & {
  readonly ACCOUNT_REGISTRATION_MODE?: "closed" | "open";
  /** `open` accepts `skit feedback send` reports. Only the official deployment opens it. */
  readonly FEEDBACK_MODE?: "closed" | "open";
  readonly PUBLIC_APP_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly SKIT_BOOTSTRAP_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly EMAIL?: SendEmail;
  readonly EMAIL_FROM?: string;
  readonly ASSETS?: Fetcher;
};

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("Cloudflare.DatabaseError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export const databaseLayer = (database: D1Database) => D1Client.layer({ db: database });

export const databaseError = (operation: string) =>
  Effect.mapError((cause: unknown) => new DatabaseError({ operation, cause }));

export class BlobStorageError extends Schema.TaggedError<BlobStorageError>()(
  "Cloudflare.BlobStorageError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** R2 deletes at most this many keys per call. */
const MAX_DELETE_KEYS = 1_000;

interface BlobPutOptions {
  readonly contentType?: string;
  /** Write only when no object has the key yet. */
  readonly onlyIfAbsent?: boolean;
}

/** The R2 operations SKIT uses. `operation` names the caller's step in a BlobStorageError. */
export interface BlobStoreService {
  readonly get: (
    operation: string,
    key: string,
  ) => Effect.Effect<Option.Option<Uint8Array>, BlobStorageError>;
  readonly stream: (
    operation: string,
    key: string,
  ) => Effect.Effect<Option.Option<ReadableStream<Uint8Array>>, BlobStorageError>;
  /** Succeeds with false when `onlyIfAbsent` found an existing object. */
  readonly put: (
    operation: string,
    key: string,
    bytes: Uint8Array,
    options?: BlobPutOptions,
  ) => Effect.Effect<boolean, BlobStorageError>;
  readonly exists: (operation: string, key: string) => Effect.Effect<boolean, BlobStorageError>;
  /** Deletes in batches of 1000 keys and stops at the first failed batch. */
  readonly delete: (
    operation: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void, BlobStorageError>;
  readonly probe: () => Effect.Effect<void, BlobStorageError>;
}

export class BlobStore extends Context.Service<BlobStore, BlobStoreService>()(
  "@skit-server-effect/BlobStore",
) {}

/** Owns the Promise boundary exposed by Cloudflare's R2 binding. */
export const blobStoreLayer = (
  bucket: Pick<R2Bucket, "get" | "put" | "head" | "delete" | "list">,
) => {
  const r2 = <A>(operation: string, run: () => Promise<A>) =>
    // oxlint-disable-next-line skit/no-promise-wrappers -- Wrangler's generated R2 binding is Promise-only; this platform module owns that SDK boundary.
    Effect.tryPromise({ try: run, catch: (cause) => new BlobStorageError({ operation, cause }) });
  return Layer.succeed(
    BlobStore,
    BlobStore.of({
      get: (operation, key) =>
        r2(operation, () => bucket.get(key)).pipe(
          Effect.flatMap((object) =>
            object === null
              ? Effect.succeedNone
              : r2(operation, () => object.bytes()).pipe(Effect.map(Option.some)),
          ),
        ),
      stream: (operation, key) =>
        r2(operation, () => bucket.get(key)).pipe(
          Effect.map((object) => Option.map(Option.fromNullishOr(object), ({ body }) => body)),
        ),
      put: (operation, key, bytes, options) =>
        r2(operation, () =>
          bucket.put(key, bytes, {
            ...(options?.onlyIfAbsent ? { onlyIf: new Headers({ "If-None-Match": "*" }) } : {}),
            ...(options?.contentType === undefined
              ? {}
              : { httpMetadata: { contentType: options.contentType } }),
          }),
        ).pipe(Effect.map((object) => object !== null)),
      exists: (operation, key) =>
        r2(operation, () => bucket.head(key)).pipe(Effect.map((object) => object !== null)),
      delete: Effect.fn("BlobStore.delete")(function* (
        operation: string,
        keys: ReadonlyArray<string>,
      ) {
        for (let index = 0; index < keys.length; index += MAX_DELETE_KEYS)
          yield* r2(operation, () => bucket.delete(keys.slice(index, index + MAX_DELETE_KEYS)));
      }),
      probe: () =>
        r2("list readiness sentinel", () => bucket.list({ limit: 1 })).pipe(Effect.asVoid),
    }),
  );
};
