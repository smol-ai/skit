import { Clock, Effect, Schema } from "effect";
import { PasswordHashError, hashPassword } from "./password.js";
import { provisionPrincipal } from "./provisioning.js";
import { normalizeNamespace } from "../namespace-name.js";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../../platform/cloudflare.js";
import { Digest, SecureRandom } from "effect/crypto";
import { BootstrapInput } from "../contracts.js";

export interface BootstrapClaimResult {
  readonly email: string;
  readonly username: string;
}

const BootstrapClaim = Schema.Struct({ claimed: Schema.Finite });
const UserCount = Schema.Struct({ count: Schema.Finite });

class InvalidBootstrapSecret extends Schema.TaggedError<
  InvalidBootstrapSecret,
  { readonly brand: unique symbol }
>()("Bootstrap.InvalidSecret", {}) {}
class InvalidBootstrapInput extends Schema.TaggedError<
  InvalidBootstrapInput,
  { readonly brand: unique symbol }
>()("Bootstrap.InvalidInput", {}) {}
class BootstrapComplete extends Schema.TaggedError<
  BootstrapComplete,
  { readonly brand: unique symbol }
>()("Bootstrap.Complete", {}) {}
class BootstrapUnavailable extends Schema.TaggedError<
  BootstrapUnavailable,
  { readonly brand: unique symbol }
>()("Bootstrap.Unavailable", {}) {}
class SecretComparisonError extends Schema.TaggedError<
  SecretComparisonError,
  { readonly brand: unique symbol }
>()("Bootstrap.SecretComparisonError", { cause: Schema.Defect() }) {}

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

const digest = (digests: Digest.Digest["Service"], value: string) =>
  digests
    .digest(Digest.sha256, new TextEncoder().encode(value))
    .pipe(Effect.mapError((cause) => new SecretComparisonError({ cause })));

const secretsMatch = (digests: Digest.Digest["Service"], actual: string, expected: string) =>
  Effect.all([digest(digests, actual), digest(digests, expected)]).pipe(
    Effect.map(([left, right]) => {
      let difference = left.byteLength ^ right.byteLength;
      for (let index = 0; index < Math.max(left.byteLength, right.byteLength); index++)
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      return difference === 0;
    }),
  );

export const makeBootstrap = (sql: DatabaseSqlClient, bootstrapSecret: string | undefined) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom;
    const digests = yield* Digest.Digest;
    const clock = yield* Clock.Clock;
    const db = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
      effect.pipe(databaseError(operation));

    const isNeeded = Effect.fn("Bootstrap.isNeeded")(function* () {
      if (bootstrapSecret === undefined) return false;
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
      if (bootstrapSecret === undefined) return yield* new BootstrapUnavailable();
      if (!(yield* secretsMatch(digests, input.token, bootstrapSecret)))
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

      const userId = yield* random.uuidV4();
      const accountId = yield* random.uuidV4();
      const principalId = `principal_${(yield* random.uuidV4()).replaceAll("-", "")}`;
      const now = yield* clock.currentTimeMillis;
      const timestamp = new Date(now).toISOString();
      const passwordHash = yield* hashPassword(input.password);
      const committed = yield* db(
        "commit initial operator",
        sql.batch([
          sql`INSERT INTO user (id, name, username, email, emailVerified, createdAt, updatedAt)
            VALUES (${userId}, ${username}, ${username}, ${email}, 0, ${now}, ${now})`,
          sql`INSERT INTO account
             (id, accountId, providerId, userId, password, createdAt, updatedAt)
            VALUES (${accountId}, ${userId}, 'credential', ${userId}, ${passwordHash}, ${now}, ${now})`,
          ...provisionPrincipal(sql, { userId, username, principalId, timestamp }),
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

    return { isNeeded, createInitialOperator } satisfies BootstrapService;
  });
