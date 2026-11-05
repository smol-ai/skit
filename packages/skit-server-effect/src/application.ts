import { BrowserCrypto } from "@effect/platform-browser";
import { Layer } from "effect";
import { layer as identityLayer, type Scope as AuthenticationScope } from "./identity/service.js";
import { layer as authorizationLayer } from "./authorization/service.js";
import { ServerConfiguration } from "./configuration.js";
import { layer as skitsLayer } from "./skits/service.js";
import { layer as feedbackServiceLayer } from "./feedback/service.js";
import { layer as serverLibraryLayer } from "./library/service.js";
import { blobStoreLayer, databaseLayer, type RuntimeEnv } from "./platform/cloudflare.js";
import { layer as teamsLayer } from "./teams/service.js";

export interface AuthenticatedConfiguration {
  readonly env: RuntimeEnv;
  readonly publicAppOrigin: string;
  readonly betterAuthSecret: string;
  readonly github?: { readonly clientId: string; readonly clientSecret: string };
}

export type AuthenticationConfiguration =
  | { readonly _tag: "Configured"; readonly value: AuthenticatedConfiguration }
  | { readonly _tag: "Missing"; readonly detail: string }
  | { readonly _tag: "Invalid"; readonly detail: string };

export const authenticationConfiguration = (env: RuntimeEnv): AuthenticationConfiguration => {
  if (!env.PUBLIC_APP_ORIGIN) return { _tag: "Missing", detail: "PUBLIC_APP_ORIGIN is required" };
  if (!env.BETTER_AUTH_SECRET) return { _tag: "Missing", detail: "BETTER_AUTH_SECRET is required" };
  const origin = URL.parse(env.PUBLIC_APP_ORIGIN);
  if (origin === null) return { _tag: "Invalid", detail: "PUBLIC_APP_ORIGIN must be a valid URL" };
  if (
    origin.protocol !== "https:" &&
    origin.hostname !== "localhost" &&
    origin.hostname !== "127.0.0.1"
  )
    return { _tag: "Invalid", detail: "PUBLIC_APP_ORIGIN must use HTTPS" };
  if (env.GITHUB_CLIENT_ID && !env.GITHUB_CLIENT_SECRET)
    return { _tag: "Invalid", detail: "GITHUB_CLIENT_SECRET is required with GITHUB_CLIENT_ID" };
  if (env.GITHUB_CLIENT_SECRET && !env.GITHUB_CLIENT_ID)
    return { _tag: "Invalid", detail: "GITHUB_CLIENT_ID is required with GITHUB_CLIENT_SECRET" };
  if (env.EMAIL && !env.EMAIL_FROM)
    return { _tag: "Invalid", detail: "EMAIL_FROM is required with the EMAIL binding" };
  if (env.EMAIL_FROM && !env.EMAIL)
    return { _tag: "Invalid", detail: "the EMAIL binding is required with EMAIL_FROM" };
  return {
    _tag: "Configured",
    value: {
      env,
      publicAppOrigin: origin.origin,
      betterAuthSecret: env.BETTER_AUTH_SECRET,
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {}),
    },
  };
};

export const applicationLayers = (
  env: RuntimeEnv,
  configured: AuthenticatedConfiguration | undefined,
  supportedScopes: ReadonlySet<AuthenticationScope>,
) => {
  const platform = Layer.mergeAll(
    blobStoreLayer(env.SKIT_BLOBS),
    databaseLayer(env.DB),
    BrowserCrypto.layer,
  );
  const authorization = authorizationLayer.pipe(Layer.provideMerge(platform));
  const release = skitsLayer.pipe(Layer.provide(authorization));
  // Feedback does not wait for authentication to be configured: reports can always be anonymous.
  const feedback =
    env.FEEDBACK_MODE === "open" ? feedbackServiceLayer.pipe(Layer.provide(platform)) : undefined;
  if (configured === undefined) return { release, feedback, authenticated: undefined };

  const authenticated = Layer.mergeAll(
    identityLayer(
      {
        database: env.DB,
        publicAppOrigin: configured.publicAppOrigin,
        secret: configured.betterAuthSecret,
        registrationMode: env.ACCOUNT_REGISTRATION_MODE,
        github: configured.github,
        email:
          env.EMAIL && env.EMAIL_FROM ? { binding: env.EMAIL, from: env.EMAIL_FROM } : undefined,
      },
      supportedScopes,
      env.SKIT_BOOTSTRAP_SECRET || undefined,
    ),
    serverLibraryLayer,
    skitsLayer,
    Layer.succeed(ServerConfiguration, { publicAppOrigin: configured.publicAppOrigin }),
  ).pipe(Layer.provideMerge(teamsLayer), Layer.provideMerge(authorization));
  return { release, feedback, authenticated };
};
