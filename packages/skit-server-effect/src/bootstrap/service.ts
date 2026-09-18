import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { PasswordHashError, PasswordHasher, type PasswordHasherService } from "../auth/password.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { BootstrapInput } from "./contracts.js";
export { BootstrapInput, BootstrapResult } from "./contracts.js";

export interface BootstrapClaimResult {
  readonly email: string;
  readonly username: string;
}

const CREDENTIAL_ISSUER = "local:credential";
const BootstrapClaim = Schema.Struct({ claimed: Schema.Number });
const UserCount = Schema.Struct({ count: Schema.Number });

export class InvalidBootstrapSecret extends Schema.TaggedError<InvalidBootstrapSecret>()(
  "Bootstrap.InvalidSecret",
  {},
) {}
export class InvalidBootstrapInput extends Schema.TaggedError<InvalidBootstrapInput>()(
  "Bootstrap.InvalidInput",
  {},
) {}
export class BootstrapComplete extends Schema.TaggedError<BootstrapComplete>()(
  "Bootstrap.Complete",
  {},
) {}
export class BootstrapUnavailable extends Schema.TaggedError<BootstrapUnavailable>()(
  "Bootstrap.Unavailable",
  {},
) {}
export class SecretComparisonError extends Schema.TaggedError<SecretComparisonError>()(
  "Bootstrap.SecretComparisonError",
  { cause: Schema.Defect() },
) {}

export type CreateError =
  | InvalidBootstrapSecret
  | InvalidBootstrapInput
  | BootstrapComplete
  | BootstrapUnavailable
  | SecretComparisonError
  | DatabaseError
  | PasswordHashError;

export interface BootstrapService {
  readonly isNeeded: () => Effect.Effect<boolean, DatabaseError>;
  readonly createInitialOperator: (
    input: BootstrapInput,
  ) => Effect.Effect<BootstrapClaimResult, CreateError>;
}

export class Bootstrap extends Context.Service<Bootstrap, BootstrapService>()(
  "@skit-server-effect/Bootstrap",
) {}

const digest = (crypto: Crypto, value: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- Web Crypto is Promise-only; Bootstrap owns this secret-comparison boundary.
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    catch: (cause) => new SecretComparisonError({ cause }),
  }).pipe(Effect.map((bytes) => new Uint8Array(bytes)));

const secretsMatch = (crypto: Crypto, actual: string, expected: string) =>
  Effect.all([digest(crypto, actual), digest(crypto, expected)]).pipe(
    Effect.map(([left, right]) => {
      let difference = left.byteLength ^ right.byteLength;
      for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index++)
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      return difference === 0;
    }),
  );

export const layer = (bootstrapSecret: string) =>
  Layer.effect(
    Bootstrap,
    Effect.gen(function* () {
      const sql: DatabaseSqlClient = yield* D1Client.D1Client;
      const passwordHasher: PasswordHasherService = yield* PasswordHasher;
      const crypto = yield* NativeCrypto;
      const clock = yield* Clock.Clock;
      const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
        effect.pipe(databaseError(operation));

      const isNeeded = Effect.fn("Bootstrap.isNeeded")(function* () {
        const rows = yield* db(
          "read bootstrap claim",
          sql`SELECT 1 claimed FROM server_bootstrap WHERE id = 'singleton'`,
        );
        if (rows[0] === undefined) return true;
        yield* Schema.decodeUnknownEffect(BootstrapClaim)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode bootstrap claim", cause }),
          ),
        );
        return false;
      });

      const createInitialOperator = Effect.fn("Bootstrap.createInitialOperator")(function* (
        input: BootstrapInput,
      ) {
        if (!(yield* secretsMatch(crypto, input.token, bootstrapSecret)))
          return yield* new InvalidBootstrapSecret();
        const username = normalizeNamespace(input.username);
        const email = input.email.trim().toLowerCase();
        if (
          username === undefined ||
          !/^\S+@\S+\.\S+$/.test(email) ||
          input.password.length < 8 ||
          input.password.length > 128
        )
          return yield* new InvalidBootstrapInput();
        if (!(yield* isNeeded())) return yield* new BootstrapComplete();

        const countRows = yield* db(
          "count users before bootstrap",
          sql`SELECT COUNT(*) count FROM user`,
        );
        const { count } = yield* Schema.decodeUnknownEffect(UserCount)(countRows[0]).pipe(
          Effect.mapError((cause) => new DatabaseError({ operation: "decode user count", cause })),
        );
        if (count > 0) return yield* new BootstrapUnavailable();

        const userId = crypto.randomUUID();
        const accountId = crypto.randomUUID();
        const principalId = `principal_${crypto.randomUUID().replaceAll("-", "")}`;
        const now = yield* clock.currentTimeMillis;
        const timestamp = new Date(now).toISOString();
        const passwordHash = yield* passwordHasher.hash(input.password);
        const committed = yield* db(
          "commit initial operator",
          sql.batch([
            sql`INSERT INTO user (id, name, username, email, emailVerified, createdAt, updatedAt)
            VALUES (${userId}, ${username}, ${username}, ${email}, 0, ${now}, ${now})`,
            sql`INSERT INTO account
             (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt)
            VALUES (${accountId}, ${CREDENTIAL_ISSUER}, ${userId}, 'credential', ${userId}, ${passwordHash}, ${now}, ${now})`,
            sql`INSERT INTO principals (principal_id, better_auth_user_id, created_at, updated_at)
            VALUES (${principalId}, ${userId}, ${timestamp}, ${timestamp})`,
            sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
            VALUES (${username}, 'principal', ${principalId}, ${timestamp})`,
            sql`INSERT INTO server_operators (principal_id, created_at)
            VALUES (${principalId}, ${timestamp})`,
            sql`INSERT INTO server_bootstrap (id, claimed_at, claimed_by)
            VALUES ('singleton', ${timestamp}, ${principalId})`,
          ]),
        ).pipe(Effect.result);
        if (committed._tag === "Failure") {
          const stillNeeded = yield* isNeeded().pipe(Effect.result);
          if (stillNeeded._tag === "Success" && !stillNeeded.success)
            return yield* new BootstrapComplete();
          return yield* committed.failure;
        }
        return { email, username };
      });

      return Bootstrap.of({ isNeeded, createInitialOperator });
    }),
  );
