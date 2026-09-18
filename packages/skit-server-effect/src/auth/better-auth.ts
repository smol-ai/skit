import { betterAuth } from "better-auth";
import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { schemaBodyJsonLimited } from "../api/request-body.js";
import { normalizeNamespace } from "../domain/identifiers.js";
import {
  Bindings,
  rateLimitEffect,
  type DatabaseSqlClient,
  type RuntimeEnv,
} from "../platform/cloudflare.js";
import { NativeClock } from "../platform/native-clock.js";
import { NativeCrypto } from "../platform/native-crypto.js";
import { passwordCallbacks } from "./password.js";

export const AUTH_BASE_PATH = "/api/auth";
const MAX_USERNAME_REQUEST_BYTES = 4 * 1024;
const UsernameClaimInput = Schema.Struct({ username: Schema.String });
const UsernameClaimRow = Schema.Struct({
  username: Schema.NullOr(Schema.String),
  claimed: Schema.NullOr(Schema.String),
});

const UserIdentity = Schema.Struct({
  id: Schema.String,
  emailVerified: Schema.Boolean,
  username: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  session: Schema.Struct({ authorizationGeneration: Schema.optionalKey(Schema.Number) }),
});

export interface SessionIdentity {
  readonly userId: string;
  readonly authorizationGeneration: number;
}

export class BetterAuthError extends Schema.TaggedError<BetterAuthError>()(
  "BetterAuth.AdapterError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class InvalidUsername extends Schema.TaggedError<InvalidUsername>()(
  "BetterAuth.InvalidUsername",
  {},
) {}
export class UsernameUnavailable extends Schema.TaggedError<UsernameUnavailable>()(
  "BetterAuth.UsernameUnavailable",
  {},
) {}

export interface BetterAuthService {
  readonly handle: (request: Request) => Effect.Effect<Response, BetterAuthError>;
  readonly getSession: (
    headers: Headers,
  ) => Effect.Effect<SessionIdentity | undefined, BetterAuthError>;
  readonly claimUsername: (
    userId: string,
    username: string,
  ) => Effect.Effect<string, InvalidUsername | UsernameUnavailable | BetterAuthError>;
  readonly sendVerificationEmail: (email: string) => Effect.Effect<boolean, BetterAuthError>;
}

export class BetterAuth extends Context.Service<BetterAuth, BetterAuthService>()(
  "@skit-server-effect/BetterAuth",
) {}

export interface BetterAuthConfiguration {
  readonly publicAppOrigin: string;
  readonly secret: string;
  readonly registrationMode: string | undefined;
  readonly github?: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  readonly email?: {
    readonly binding: SendEmail;
    readonly from: string;
  };
}

export const githubAccountLinkingPolicy = {
  enabled: true,
  trustedProviders: ["github"],
  // A bootstrapped operator has proven control of the one-time server secret,
  // but a Registry without an Email Service cannot verify its local email.
  // GitHub still has to return the same email; allowDifferentEmails stays false.
  requireLocalEmailVerified: false,
};

export const layer = (configuration: BetterAuthConfiguration) =>
  Layer.effect(
    BetterAuth,
    Effect.gen(function* () {
      const bindings = yield* Bindings;
      const sql: DatabaseSqlClient = yield* D1Client.D1Client;
      const crypto = yield* NativeCrypto;
      const { now } = yield* NativeClock;
      const passwords = passwordCallbacks(crypto);
      const email = configuration.email;
      const auth = betterAuth({
        appName: "SKIT",
        baseURL: configuration.publicAppOrigin,
        basePath: AUTH_BASE_PATH,
        secret: configuration.secret,
        database: bindings.database,
        trustedOrigins: [configuration.publicAppOrigin],
        telemetry: { enabled: false },
        advanced: {
          cookiePrefix: "skit-auth",
          useSecureCookies: configuration.publicAppOrigin.startsWith("https://"),
        },
        emailAndPassword: {
          enabled: true,
          disableSignUp: configuration.registrationMode !== "open",
          requireEmailVerification: email !== undefined,
          minPasswordLength: 8,
          maxPasswordLength: 128,
          password: passwords,
          ...(email
            ? {
                sendResetPassword: ({ user, url }: { user: { email: string }; url: string }) =>
                  email.binding
                    .send({
                      from: email.from,
                      to: user.email,
                      subject: "Reset your SKIT password",
                      text: `Reset your SKIT password: ${url}`,
                    })
                    .then(() => undefined),
              }
            : {}),
        },
        ...(email
          ? {
              emailVerification: {
                sendOnSignUp: true,
                expiresIn: 60 * 60,
                autoSignInAfterVerification: true,
                sendVerificationEmail: ({ user, url }: { user: { email: string }; url: string }) =>
                  email.binding
                    .send({
                      from: email.from,
                      to: user.email,
                      subject: "Verify your SKIT email",
                      text: `Verify your SKIT email: ${url}`,
                    })
                    .then(() => undefined),
              },
            }
          : {}),
        ...(configuration.github
          ? {
              account: { accountLinking: githubAccountLinkingPolicy },
              socialProviders: {
                github: {
                  clientId: configuration.github.clientId,
                  clientSecret: configuration.github.clientSecret,
                  disableImplicitSignUp: configuration.registrationMode !== "open",
                },
              },
            }
          : {}),
        user: {
          additionalFields: {
            username: {
              type: "string",
              required: false,
              input: true,
              returned: true,
              transform: {
                input: (value) => {
                  if (email !== undefined && value === null) return null;
                  // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth transform callbacks signal invalid input by throwing.
                  if (typeof value !== "string") throw new Error("INVALID_USERNAME");
                  const username = normalizeNamespace(value);
                  // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth transform callbacks signal invalid input by throwing.
                  if (!username) throw new Error("INVALID_USERNAME");
                  return username;
                },
              },
            },
          },
        },
        session: {
          expiresIn: 7 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          additionalFields: {
            authorizationGeneration: {
              type: "number",
              required: true,
              input: false,
              defaultValue: 1,
            },
          },
        },
        databaseHooks: {
          user: {
            create: {
              before: async (user) => {
                if (email === undefined || user.emailVerified) return { data: user };
                return { data: { ...user, username: null } };
              },
              after: async (unknownUser) => {
                const decoded = Schema.decodeUnknownOption(UserIdentity)(unknownUser);
                // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth database hooks are Promise callbacks and reject by throwing.
                if (Option.isNone(decoded)) throw new Error("INVALID_USER_IDENTITY");
                if (
                  decoded.value.username == null ||
                  (email !== undefined && !decoded.value.emailVerified)
                )
                  return;
                const timestamp = now().toISOString();
                const principalId = `principal_${crypto.randomUUID().replaceAll("-", "")}`;
                try {
                  await bindings.database.batch([
                    bindings.database
                      .prepare(
                        `INSERT INTO principals (principal_id, better_auth_user_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?)`,
                      )
                      .bind(principalId, decoded.value.id, timestamp, timestamp),
                    bindings.database
                      .prepare(
                        `INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
                   VALUES (?, 'principal', ?, ?)`,
                      )
                      .bind(decoded.value.username, principalId, timestamp),
                  ]);
                } catch (cause) {
                  console.error("skit-server Principal provisioning failed", cause);
                  try {
                    await bindings.database
                      .prepare("DELETE FROM user WHERE id = ?")
                      .bind(decoded.value.id)
                      .run();
                  } catch (cleanupCause) {
                    console.error("skit-server incomplete signup cleanup failed", cleanupCause);
                  }
                  // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth database hooks are Promise callbacks and reject by throwing.
                  throw cause;
                }
              },
            },
          },
          session: {
            create: {
              before: async (session) => {
                const principal = await bindings.database
                  .prepare(
                    `SELECT state, authorization_generation
               FROM principals WHERE better_auth_user_id = ?`,
                  )
                  .bind(session.userId)
                  .first<{ state: string; authorization_generation: number }>();
                if (principal && principal.state !== "active") return false;
                return {
                  data: {
                    ...session,
                    authorizationGeneration: principal?.authorization_generation ?? 1,
                  },
                };
              },
            },
          },
        },
        rateLimit: { enabled: false },
      });

      const handle = Effect.fn("BetterAuth.handle")((request: Request) =>
        // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth exposes a Promise-only Fetch handler; this adapter owns that integration boundary.
        Effect.tryPromise({
          try: () => auth.handler(request),
          catch: (cause) => new BetterAuthError({ operation: "handle request", cause }),
        }),
      );

      const getSession = Effect.fn("BetterAuth.getSession")((headers: Headers) =>
        // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth exposes a Promise-only session API; this adapter owns that integration boundary.
        Effect.tryPromise({
          try: () => auth.api.getSession({ headers }),
          catch: (cause) => new BetterAuthError({ operation: "read session", cause }),
        }).pipe(
          Effect.flatMap((unknownSession) => {
            if (unknownSession === null) return Effect.succeed(undefined);
            return Schema.decodeUnknownEffect(SessionIdentity)(unknownSession).pipe(
              Effect.map(({ user, session }) => ({
                userId: user.id,
                authorizationGeneration: session.authorizationGeneration ?? 1,
              })),
              Effect.mapError(
                (cause) => new BetterAuthError({ operation: "decode session", cause }),
              ),
            );
          }),
        ),
      );

      const claimUsername = Effect.fn("BetterAuth.claimUsername")(function* (
        userId: string,
        requestedUsername: string,
      ) {
        const username = normalizeNamespace(requestedUsername);
        if (username === undefined) return yield* new InvalidUsername();
        const rows = yield* sql`SELECT u.username username, n.namespace_slug claimed
      FROM user u
      LEFT JOIN namespaces n ON n.namespace_slug = ${username}
      WHERE u.id = ${userId}`.pipe(
          Effect.mapError(
            (cause) => new BetterAuthError({ operation: "read username claim", cause }),
          ),
        );
        if (rows[0] === undefined)
          return yield* new BetterAuthError({
            operation: "claim username for missing user",
            cause: userId,
          });
        const existing = yield* Schema.decodeUnknownEffect(UsernameClaimRow)(rows[0]).pipe(
          Effect.mapError(
            (cause) => new BetterAuthError({ operation: "decode username claim", cause }),
          ),
        );
        if (existing.username !== null) return existing.username;
        if (existing.claimed !== null) return yield* new UsernameUnavailable();

        const timestamp = now().toISOString();
        const principalId = `principal_${crypto.randomUUID().replaceAll("-", "")}`;
        yield* sql
          .batch([
            sql`UPDATE user SET username = ${username}, name = ${username}, updatedAt = ${now().getTime()}
            WHERE id = ${userId} AND username IS NULL`,
            sql`INSERT INTO principals (principal_id, better_auth_user_id, created_at, updated_at)
            VALUES (${principalId}, ${userId}, ${timestamp}, ${timestamp})`,
            sql`INSERT INTO namespaces (namespace_slug, subject_kind, subject_id, created_at)
            VALUES (${username}, 'principal', ${principalId}, ${timestamp})`,
          ])
          .pipe(
            Effect.mapError((cause) => new BetterAuthError({ operation: "claim username", cause })),
          );
        return username;
      });

      const sendVerificationEmail = Effect.fn("BetterAuth.sendVerificationEmail")(
        (address: string) =>
          email === undefined
            ? Effect.succeed(false)
            : // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth exposes a Promise-only verification API; this adapter owns that integration boundary.
              Effect.tryPromise({
                try: () =>
                  auth.api.sendVerificationEmail({
                    body: { email: address, callbackURL: configuration.publicAppOrigin },
                  }),
                catch: (cause) =>
                  new BetterAuthError({ operation: "send verification email", cause }),
              }).pipe(Effect.as(true)),
      );

      return BetterAuth.of({ handle, getSession, claimUsername, sendVerificationEmail });
    }),
  );

const storageFailure = HttpServerResponse.json(
  { error: "storage_failure" },
  { status: 500, headers: { "cache-control": "no-store" } },
).pipe(Effect.orDie);

export const handleRequest = Effect.fn("BetterAuthHttp.handleRequest")(function* (env: RuntimeEnv) {
  const betterAuth = yield* BetterAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.tapError((error) => Effect.logError("authentication request conversion failed", error)),
    Effect.catch(() => storageFailure),
  );
  if (HttpServerResponse.isHttpServerResponse(webRequest)) return webRequest;

  const pathname = new URL(webRequest.url).pathname;
  if (
    webRequest.method === "POST" &&
    [
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/send-verification-email",
    ].includes(pathname)
  ) {
    const clientIp = webRequest.headers.get("cf-connecting-ip") ?? "unknown";
    const outcome = yield* rateLimitEffect(env.AUTH_RATE_LIMITER, `${pathname}:${clientIp}`).pipe(
      Effect.tapError((error) => Effect.logError("authentication rate limit failed", error)),
      Effect.catchTag("Cloudflare.RateLimitError", () => Effect.succeed(undefined)),
    );
    if (outcome === undefined) return yield* storageFailure;
    if (!outcome.success)
      return yield* HttpServerResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "cache-control": "no-store", "retry-after": "60" },
        },
      ).pipe(Effect.orDie);
  }

  return yield* betterAuth.handle(webRequest).pipe(
    Effect.map(HttpServerResponse.fromWeb),
    Effect.tapError((error) => Effect.logError("authentication failed", error)),
    Effect.catchTag("BetterAuth.AdapterError", () => storageFailure),
  );
});

export const handleUsernameClaim = Effect.fn("BetterAuthHttp.handleUsernameClaim")(function* (
  env: RuntimeEnv,
) {
  const betterAuth = yield* BetterAuth;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (webRequest === undefined)
    return yield* HttpServerResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  if (webRequest.headers.get("origin") !== env.PUBLIC_APP_ORIGIN)
    return yield* HttpServerResponse.json(
      { error: "forbidden_origin" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  const session = yield* betterAuth
    .getSession(webRequest.headers)
    .pipe(Effect.catchTag("BetterAuth.AdapterError", () => Effect.succeed(undefined)));
  if (session === undefined)
    return yield* HttpServerResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  const input = yield* schemaBodyJsonLimited(
    request,
    UsernameClaimInput,
    MAX_USERNAME_REQUEST_BYTES,
  ).pipe(Effect.option);
  if (Option.isNone(input))
    return yield* HttpServerResponse.json(
      { error: "invalid_request" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  const result = yield* betterAuth
    .claimUsername(session.userId, input.value.username)
    .pipe(Effect.result);
  if (result._tag === "Failure") {
    if (result.failure._tag === "BetterAuth.InvalidUsername")
      return yield* HttpServerResponse.json(
        { error: "invalid_username" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    if (result.failure._tag === "BetterAuth.UsernameUnavailable")
      return yield* HttpServerResponse.json(
        { error: "username_unavailable" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    yield* Effect.logError("username claim failed", result.failure);
    return yield* HttpServerResponse.json(
      { error: "storage_failure" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
  return yield* HttpServerResponse.json(
    { username: result.success },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
