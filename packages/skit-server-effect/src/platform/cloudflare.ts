import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Schema } from "effect";

export interface CloudflareBindings {
  readonly database: D1Database;
  readonly blobs: R2Bucket;
}

export type DatabaseSqlClient = D1Client.D1Client;

export type RuntimeEnv = Omit<Env, "ACCOUNT_REGISTRATION_MODE" | "ASSETS" | "PUBLIC_APP_ORIGIN"> & {
  readonly ACCOUNT_REGISTRATION_MODE?: "closed" | "open";
  readonly PUBLIC_APP_ORIGIN?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly SKIT_BOOTSTRAP_SECRET?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly EMAIL?: SendEmail;
  readonly EMAIL_FROM?: string;
  readonly ASSETS?: Fetcher;
};

export class Bindings extends Context.Service<Bindings, CloudflareBindings>()(
  "@skit-server-effect/CloudflareBindings",
) {}

export const layer = (env: Pick<RuntimeEnv, "DB" | "SKIT_BLOBS">) =>
  Layer.succeed(Bindings, {
    database: env.DB,
    blobs: env.SKIT_BLOBS,
  });

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

export class RateLimitError extends Schema.TaggedError<RateLimitError>()(
  "Cloudflare.RateLimitError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const blobStorageEffectFrom = <A>(
  blobs: R2Bucket,
  operation: string,
  run: (blobs: R2Bucket) => Promise<A>,
): Effect.Effect<A, BlobStorageError> =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Wrangler's generated R2 binding is Promise-only; this platform module owns that SDK boundary.
  Effect.tryPromise({
    try: () => run(blobs),
    catch: (cause) => new BlobStorageError({ operation, cause }),
  });

export const r2BodyEffect = <A>(operation: string, run: () => Promise<A>) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Wrangler's generated R2 body is Promise-only; this platform module owns that SDK boundary.
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BlobStorageError({ operation, cause }),
  });

/** Owns the Promise boundary exposed by Cloudflare's R2 binding. */
export const blobStorageEffect = <A>(
  operation: string,
  run: (blobs: R2Bucket) => Promise<A>,
): Effect.Effect<A, BlobStorageError, Bindings> =>
  Effect.flatMap(Bindings, ({ blobs }) => blobStorageEffectFrom(blobs, operation, run));

/** Owns the Promise boundary exposed by Cloudflare's rate-limit binding. */
export const rateLimitEffect = (rateLimiter: RateLimit, key: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Wrangler's generated RateLimit binding is Promise-only; this platform module owns that SDK boundary.
  Effect.tryPromise({
    try: () => rateLimiter.limit({ key }),
    catch: (cause) => new RateLimitError({ operation: "limit request", cause }),
  });
