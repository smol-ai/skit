import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Crypto, Effect, Layer, Schema } from "effect";
import { DatabaseError, databaseError, type DatabaseSqlClient } from "../platform/cloudflare.js";
import { BetterAuth, type BetterAuthError, type BetterAuthService } from "./better-auth.js";
import { CreatePatInput, CreatedPat, ListedPat, Scope } from "./contracts.js";
export { CreatePatInput, CreatedPat, ListedPat, Scope } from "./contracts.js";

export interface Principal {
  readonly id: string;
  readonly credential: "session" | "personal_access_token";
  readonly scopes: ReadonlySet<Scope>;
  readonly tokenId?: string;
}

const PatRow = Schema.Struct({
  principal_id: Schema.String,
  token_id: Schema.String,
  state: Schema.String,
  authorization_generation: Schema.Number,
  token_generation: Schema.Number,
  scopes_json: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
});
const StoredScopes = Schema.fromJsonString(Schema.Array(Scope));
const PrincipalGeneration = Schema.Struct({ authorization_generation: Schema.Number });
const SessionPrincipalRow = Schema.Struct({
  principal_id: Schema.String,
  state: Schema.String,
  authorization_generation: Schema.Number,
});
const ListedPatRow = Schema.Struct({
  token_id: Schema.String,
  token_prefix: Schema.String,
  name: Schema.String,
  scopes_json: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  revoked_at: Schema.NullOr(Schema.String),
  last_used_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});
const RFC_3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class SessionRequired extends Schema.TaggedError<SessionRequired>()(
  "Authentication.SessionRequired",
  {},
) {}
export class InvalidScope extends Schema.TaggedError<InvalidScope>()(
  "Authentication.InvalidScope",
  {},
) {}
export class InvalidExpiry extends Schema.TaggedError<InvalidExpiry>()(
  "Authentication.InvalidExpiry",
  {},
) {}
export class UnauthorizedPrincipal extends Schema.TaggedError<UnauthorizedPrincipal>()(
  "Authentication.UnauthorizedPrincipal",
  {},
) {}

export class AuthenticationCryptoError extends Schema.TaggedError<AuthenticationCryptoError>()(
  "Authentication.CryptoError",
  { cause: Schema.Defect() },
) {}

export interface AuthenticationService {
  readonly authenticate: (
    request: Request,
  ) => Effect.Effect<
    Principal | undefined,
    DatabaseError | AuthenticationCryptoError | BetterAuthError
  >;
  readonly authenticatePat: (
    token: string,
  ) => Effect.Effect<Principal | undefined, DatabaseError | AuthenticationCryptoError>;
  readonly createPat: (
    principal: Principal,
    input: CreatePatInput,
  ) => Effect.Effect<
    CreatedPat,
    | SessionRequired
    | InvalidScope
    | InvalidExpiry
    | UnauthorizedPrincipal
    | AuthenticationCryptoError
    | DatabaseError
  >;
  readonly listPats: (
    principal: Principal,
  ) => Effect.Effect<ReadonlyArray<ListedPat>, SessionRequired | DatabaseError>;
  readonly revokePat: (
    principal: Principal,
    tokenId: string,
  ) => Effect.Effect<boolean, SessionRequired | DatabaseError>;
}

export class Authentication extends Context.Service<Authentication, AuthenticationService>()(
  "@skit-server-effect/Authentication",
) {}

const sha256 = (crypto: Crypto.Crypto, value: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.mapError((cause) => new AuthenticationCryptoError({ cause })),
    Effect.map((digest) =>
      Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export const layer = (supportedScopes: ReadonlySet<Scope>) =>
  Layer.effect(
    Authentication,
    Effect.gen(function* () {
      const sql: DatabaseSqlClient = yield* D1Client.D1Client;
      const crypto = yield* Crypto.Crypto;
      const clock = yield* Clock.Clock;
      const betterAuth: Pick<BetterAuthService, "getSession"> = yield* BetterAuth;
      const db = <A>(operation: string, effect: Effect.Effect<A, unknown>) =>
        effect.pipe(databaseError(operation));

      const authenticatePat = Effect.fn("Authentication.authenticatePat")(function* (
        token: string,
      ) {
        if (!token.startsWith("skit_pat_")) return undefined;
        const tokenHash = yield* sha256(crypto, token);
        const rows = yield* db(
          "find personal access token",
          sql`SELECT p.principal_id, p.state, p.authorization_generation,
                  t.token_id, t.authorization_generation token_generation,
                  t.scopes_json, t.expires_at, t.revoked_at
           FROM personal_access_tokens t
           JOIN principals p ON p.principal_id = t.principal_id
           WHERE t.token_hash = ${tokenHash}`,
        );
        if (rows[0] === undefined) return undefined;
        const row = yield* Schema.decodeUnknownEffect(PatRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode access token", cause }),
          ),
        );
        const now = new Date(yield* clock.currentTimeMillis).toISOString();
        if (
          row.state !== "active" ||
          row.revoked_at !== null ||
          row.authorization_generation !== row.token_generation ||
          (row.expires_at !== null && row.expires_at <= now)
        )
          return undefined;
        const scopes = yield* Schema.decodeUnknownEffect(StoredScopes)(row.scopes_json).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode access token scopes", cause }),
          ),
        );
        yield* db(
          "record access token use",
          sql`UPDATE personal_access_tokens SET last_used_at = ${now} WHERE token_hash = ${tokenHash}`,
        );
        return {
          id: row.principal_id,
          credential: "personal_access_token" as const,
          scopes: new Set(scopes),
          tokenId: row.token_id,
        };
      });

      const authenticate = Effect.fn("Authentication.authenticate")(function* (request: Request) {
        const authorization = request.headers.get("authorization");
        if (authorization?.startsWith("Bearer "))
          return yield* authenticatePat(authorization.slice("Bearer ".length));
        const session = yield* betterAuth.getSession(request.headers);
        if (session === undefined) return undefined;
        const rows = yield* db(
          "find session principal",
          sql`SELECT principal_id, state, authorization_generation
            FROM principals WHERE better_auth_user_id = ${session.userId}`,
        );
        if (rows[0] === undefined) return undefined;
        const row = yield* Schema.decodeUnknownEffect(SessionPrincipalRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode session principal", cause }),
          ),
        );
        if (
          row.state !== "active" ||
          row.authorization_generation !== session.authorizationGeneration
        )
          return undefined;
        return {
          id: row.principal_id,
          credential: "session" as const,
          scopes: supportedScopes,
        };
      });

      const createPat = Effect.fn("Authentication.createPat")(function* (
        principal: Principal,
        input: CreatePatInput,
      ) {
        if (principal.credential !== "session") return yield* new SessionRequired();
        if (input.scopes.length === 0 || input.scopes.some((scope) => !supportedScopes.has(scope)))
          return yield* new InvalidScope();
        const expiresAt = input.expiresAt
          ? RFC_3339_TIMESTAMP.test(input.expiresAt) && Number.isFinite(Date.parse(input.expiresAt))
            ? new Date(input.expiresAt).toISOString()
            : undefined
          : undefined;
        if (input.expiresAt !== undefined && expiresAt === undefined)
          return yield* new InvalidExpiry();

        const principalRows = yield* db(
          "read principal generation",
          sql`SELECT authorization_generation FROM principals
            WHERE principal_id = ${principal.id} AND state = 'active'`,
        );
        if (principalRows[0] === undefined) return yield* new UnauthorizedPrincipal();
        const principalRow = yield* Schema.decodeUnknownEffect(PrincipalGeneration)(
          principalRows[0],
        ).pipe(
          Effect.mapError(
            (cause) => new DatabaseError({ operation: "decode principal generation", cause }),
          ),
        );

        const bytes = yield* crypto
          .randomBytes(32)
          .pipe(Effect.mapError((cause) => new AuthenticationCryptoError({ cause })));
        const secret = btoa(String.fromCharCode(...bytes))
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", "");
        const token = `skit_pat_${secret}`;
        const uuid = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new AuthenticationCryptoError({ cause })),
        );
        const tokenId = `pat_${uuid.replaceAll("-", "")}`;
        const tokenPrefix = token.slice(0, 18);
        const tokenHash = yield* sha256(crypto, token);
        const now = new Date(yield* clock.currentTimeMillis).toISOString();
        yield* db(
          "create personal access token",
          sql`INSERT INTO personal_access_tokens
           (token_id, principal_id, token_hash, token_prefix, name, scopes_json,
            authorization_generation, expires_at, created_at)
           VALUES (${tokenId}, ${principal.id}, ${tokenHash}, ${tokenPrefix}, ${input.name},
                   ${JSON.stringify(input.scopes)}, ${principalRow.authorization_generation},
                   ${expiresAt ?? null}, ${now})`,
        );
        return {
          token,
          token_id: tokenId,
          token_prefix: tokenPrefix,
          scopes: input.scopes,
          expires_at: expiresAt ?? null,
        };
      });

      const listPats = Effect.fn("Authentication.listPats")(function* (principal: Principal) {
        if (principal.credential !== "session") return yield* new SessionRequired();
        const rows = yield* db(
          "list personal access tokens",
          sql`SELECT token_id, token_prefix, name, scopes_json, expires_at, revoked_at,
                  last_used_at, created_at
            FROM personal_access_tokens
            WHERE principal_id = ${principal.id} ORDER BY created_at DESC`,
        );
        return yield* Effect.forEach(rows, (unknownRow) =>
          Schema.decodeUnknownEffect(ListedPatRow)(unknownRow).pipe(
            Effect.mapError(
              (cause) => new DatabaseError({ operation: "decode access token list", cause }),
            ),
            Effect.flatMap(({ scopes_json, ...row }) =>
              Schema.decodeUnknownEffect(StoredScopes)(scopes_json).pipe(
                Effect.mapError(
                  (cause) =>
                    new DatabaseError({ operation: "decode listed access token scopes", cause }),
                ),
                Effect.map((scopes) => ({ ...row, scopes })),
              ),
            ),
          ),
        );
      });

      const revokePat = Effect.fn("Authentication.revokePat")(function* (
        principal: Principal,
        tokenId: string,
      ) {
        if (principal.credential === "personal_access_token" && principal.tokenId !== tokenId)
          return yield* new SessionRequired();
        const now = new Date(yield* clock.currentTimeMillis).toISOString();
        const rows = yield* db(
          "revoke personal access token",
          sql`UPDATE personal_access_tokens SET revoked_at = ${now}
            WHERE token_id = ${tokenId} AND principal_id = ${principal.id} AND revoked_at IS NULL
            RETURNING token_id`,
        );
        return rows.length === 1;
      });

      return Authentication.of({ authenticate, authenticatePat, createPat, listPats, revokePat });
    }),
  );
