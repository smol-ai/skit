import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { APIError } from "better-auth/api";
import { Clock, Effect, Option, Schema } from "effect";
import { normalizeNamespace } from "../namespace-name.js";
import type { DatabaseSqlClient } from "../../platform/cloudflare.js";
import { SecureRandom, WebCrypto } from "effect/crypto";
import { passwordCallbacks } from "./password.js";
import { provisionPrincipal } from "./provisioning.js";

const AUTH_BASE_PATH = "/api/auth";
// Read a Bearer session token as the session cookie, but drop the plugin's response hook: it copies
// every new session token into a `set-auth-token` header that page scripts can read, which would
// undo the HttpOnly cookie.
const { hooks: bearerHooks, ...bearerPlugin } = bearer({ requireSignature: false });
const bearerRequestsOnly = { ...bearerPlugin, hooks: { before: bearerHooks.before } };
/** The only device-authorization client: `skit auth login`. */
const CLI_DEVICE_CLIENT_ID = "skit-cli";
const ProvisioningRow = Schema.Struct({
  username: Schema.NullOr(Schema.String),
  namespace_slug: Schema.NullOr(Schema.String),
});

const UserIdentity = Schema.Struct({
  id: Schema.String,
  emailVerified: Schema.Boolean,
  username: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const SessionIdentity = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
  session: Schema.Struct({ authorizationGeneration: Schema.optionalKey(Schema.Finite) }),
});

interface SessionIdentity {
  readonly userId: string;
  readonly authorizationGeneration: number;
}

export class BetterAuthError extends Schema.TaggedError<
  BetterAuthError,
  { readonly brand: unique symbol }
>()("BetterAuth.AdapterError", { operation: Schema.String, cause: Schema.Defect() }) {}

class InvalidUsername extends Schema.TaggedError<
  InvalidUsername,
  { readonly brand: unique symbol }
>()("BetterAuth.InvalidUsername", {}) {}
class UsernameUnavailable extends Schema.TaggedError<
  UsernameUnavailable,
  { readonly brand: unique symbol }
>()("BetterAuth.UsernameUnavailable", {}) {}

export interface BetterAuthService {
  readonly handle: (request: Request) => Effect.Effect<Response, BetterAuthError>;
  readonly getSession: (
    headers: Headers,
  ) => Effect.Effect<SessionIdentity | undefined, BetterAuthError>;
  readonly claimUsername: (
    userId: string,
    username: string,
  ) => Effect.Effect<string, InvalidUsername | UsernameUnavailable | BetterAuthError>;
  readonly provisionedUsername: (userId: string) => Effect.Effect<string | null, BetterAuthError>;
  readonly sendVerificationEmail: (email: string) => Effect.Effect<boolean, BetterAuthError>;
}

export interface BetterAuthConfiguration {
  /** Better Auth's own adapter and its database hooks query D1 directly. */
  readonly database: D1Database;
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

const githubAccountLinkingPolicy = {
  enabled: true,
  trustedProviders: ["github"],
  // A bootstrapped operator has proven control of the one-time server secret,
  // but a Registry without an Email Service cannot verify its local email.
  // GitHub still has to return the same email; allowDifferentEmails stays false.
  // The account.create hook refuses this exception for every other password account.
  requireLocalEmailVerified: false,
};

export const makeBetterAuth = (configuration: BetterAuthConfiguration, sql: DatabaseSqlClient) =>
  Effect.gen(function* () {
    // Better Auth invokes Promise hooks outside the fiber; keep the identity owner's services.
    const services = yield* Effect.context();
    const crypto = yield* WebCrypto.WebCrypto;
    const random = yield* SecureRandom.SecureRandom;
    const clock = yield* Clock.Clock;
    const now = () => new Date(clock.currentTimeMillisUnsafe());
    const passwords = passwordCallbacks(crypto);
    const email = configuration.email;

    const readProvisioning = Effect.fn("BetterAuth.readProvisioning")(function* (userId: string) {
      const rows = yield* sql`SELECT u.username, n.namespace_slug
      FROM user u
      LEFT JOIN principals p ON p.better_auth_user_id = u.id
      LEFT JOIN namespaces n ON n.namespace_slug = u.username
        AND n.subject_kind = 'principal' AND n.subject_id = p.principal_id
      WHERE u.id = ${userId}`.pipe(
        Effect.mapError((cause) => new BetterAuthError({ operation: "read provisioning", cause })),
      );
      if (rows[0] === undefined)
        return yield* new BetterAuthError({ operation: "provision missing user", cause: userId });
      return yield* Schema.decodeUnknownEffect(ProvisioningRow)(rows[0]).pipe(
        Effect.mapError(
          (cause) => new BetterAuthError({ operation: "decode provisioning", cause }),
        ),
      );
    });

    const provision = Effect.fn("BetterAuth.provision")(function* (
      userId: string,
      username: string,
    ) {
      const principalId = `principal_${(yield* random.uuidV4()).replaceAll("-", "")}`;
      return yield* sql
        .batch(
          provisionPrincipal(sql, {
            userId,
            username,
            principalId,
            timestamp: now().toISOString(),
          }),
        )
        .pipe(Effect.mapError((cause) => new BetterAuthError({ operation: "provision", cause })));
    });

    const auth = betterAuth({
      appName: "SKIT",
      baseURL: configuration.publicAppOrigin,
      basePath: AUTH_BASE_PATH,
      secret: configuration.secret,
      database: configuration.database,
      trustedOrigins: [configuration.publicAppOrigin],
      telemetry: { enabled: false },
      plugins: [
        // `skit auth login` shows a code; the user approves it here in a signed-in browser, with any
        // sign-in method, and the CLI's poll then receives a session to create its token with.
        deviceAuthorization({
          expiresIn: "10m",
          interval: "5s",
          verificationUri: `${configuration.publicAppOrigin}/device`,
          validateClient: (clientId) => clientId === CLI_DEVICE_CLIENT_ID,
        }),
        // The token the CLI's poll receives is that session's token, sent as a Bearer credential.
        bearerRequestsOnly,
      ],
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
        account: {
          create: {
            before: async (account) => {
              if (account.providerId === "credential") return { data: account };
              // Anyone could have registered an unverified email with a password of their
              // choosing, so a provider proving that email must not inherit that password.
              const unverifiedPassword = await configuration.database
                .prepare(
                  `SELECT 1 FROM user u
               JOIN account a ON a.userId = u.id AND a.providerId = 'credential'
               WHERE u.id = ? AND u.emailVerified = 0 AND NOT EXISTS (
                 SELECT 1 FROM principals p
                 JOIN server_operators o ON o.principal_id = p.principal_id
                 WHERE p.better_auth_user_id = u.id)`,
                )
                .bind(account.userId)
                .first();
              return unverifiedPassword ? false : { data: account };
            },
          },
        },
        user: {
          create: {
            before: async (user) => {
              if (email !== undefined && !user.emailVerified)
                return { data: { ...user, username: null } };
              // Better Auth cannot create the user and its Namespace atomically, so refuse a
              // username that provisioning could never reserve.
              const taken = await configuration.database
                .prepare("SELECT 1 taken FROM namespaces WHERE namespace_slug = ?")
                .bind(user.username ?? null)
                .first();
              // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth database hooks are Promise callbacks and reject by throwing.
              if (taken)
                throw APIError.from("BAD_REQUEST", {
                  code: "USERNAME_UNAVAILABLE",
                  message: "Username is unavailable",
                });
              return { data: user };
            },
            after: async (unknownUser) => {
              const decoded = Schema.decodeOption(UserIdentity)(unknownUser);
              // oxlint-disable-next-line skit/no-throw-in-effect -- Better Auth database hooks are Promise callbacks and reject by throwing.
              if (Option.isNone(decoded)) throw new Error("INVALID_USER_IDENTITY");
              if (
                decoded.value.username == null ||
                (email !== undefined && !decoded.value.emailVerified)
              )
                return;
              // A failed batch writes nothing; the next sign-in or username claim provisions
              // the user.
              await Effect.runPromiseWith(services)(
                provision(decoded.value.id, decoded.value.username).pipe(
                  Effect.tapError((error) =>
                    Effect.logError("Principal provisioning failed", error),
                  ),
                ),
              );
            },
          },
        },
        session: {
          create: {
            before: async (session) => {
              // Sign-in repairs a user whose username was saved without its Principal Namespace.
              await Effect.runPromiseWith(services)(
                readProvisioning(session.userId).pipe(
                  Effect.flatMap(({ username, namespace_slug }) =>
                    username === null || namespace_slug !== null
                      ? Effect.void
                      : provision(session.userId, username).pipe(Effect.asVoid),
                  ),
                  Effect.catch((error) => Effect.logError("Principal repair failed", error)),
                ),
              );
              const principal = await configuration.database
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

    // Finish both initialization and its background schema check inside the acquiring request.
    // Better Auth caches the check's promise too; returning while it still reads D1 can strand
    // later session calls after this Worker request ends.
    // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth owns this Promise-only initialization boundary.
    yield* Effect.tryPromise({
      try: async () => {
        const context = await auth.$context;
        await context.checkSchema?.();
      },
      catch: (cause) => new BetterAuthError({ operation: "initialize", cause }),
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
          if (unknownSession === null) return Effect.undefined;
          return Schema.decodeEffect(SessionIdentity)(unknownSession).pipe(
            Effect.map(({ user, session }) => ({
              userId: user.id,
              authorizationGeneration: session.authorizationGeneration ?? 1,
            })),
            Effect.mapError((cause) => new BetterAuthError({ operation: "decode session", cause })),
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
      const existing = yield* readProvisioning(userId);
      if (existing.namespace_slug !== null) return existing.namespace_slug;
      const taken = yield* sql`SELECT 1 taken FROM namespaces WHERE namespace_slug = ${username}
      UNION ALL SELECT 1 taken FROM user WHERE username = ${username} AND id <> ${userId}
      LIMIT 1`.pipe(
        Effect.mapError(
          (cause) => new BetterAuthError({ operation: "read username claim", cause }),
        ),
      );
      if (taken.length !== 0) return yield* new UsernameUnavailable();

      const timestamp = now();
      yield* sql
        .batch([
          sql`UPDATE user SET name = ${username}, updatedAt = ${timestamp.getTime()}
            WHERE id = ${userId} AND username IS NULL`,
          ...provisionPrincipal(sql, {
            userId,
            username,
            principalId: `principal_${(yield* random.uuidV4()).replaceAll("-", "")}`,
            timestamp: timestamp.toISOString(),
          }),
        ])
        .pipe(
          Effect.mapError((cause) => new BetterAuthError({ operation: "claim username", cause })),
        );
      const claimed = yield* readProvisioning(userId);
      if (claimed.namespace_slug === null)
        return yield* new BetterAuthError({ operation: "claim username", cause: userId });
      return claimed.namespace_slug;
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

    const provisionedUsername = Effect.fn("BetterAuth.provisionedUsername")((userId: string) =>
      readProvisioning(userId).pipe(Effect.map(({ namespace_slug }) => namespace_slug)),
    );

    return {
      handle,
      getSession,
      claimUsername,
      provisionedUsername,
      sendVerificationEmail,
    } satisfies BetterAuthService;
  });
