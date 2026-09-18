import { BrowserCrypto } from "@effect/platform-browser";
import { Layer } from "effect";
import {
  layer as authenticationLayer,
  type Scope as AuthenticationScope,
} from "./auth/authentication.js";
import { layer as betterAuthLayer } from "./auth/better-auth.js";
import { layer as passwordHasherLayer } from "./auth/password.js";
import { layer as authorInventoryLayer } from "./author-inventory/service.js";
import { layer as authorizationLayer } from "./authorization/service.js";
import { layer as bootstrapServiceLayer } from "./bootstrap/service.js";
import { ServerConfiguration } from "./configuration.js";
import { layer as draftsLayer } from "./drafts/service.js";
import { layer as librariesLayer } from "./library/service.js";
import { layer as portableLibrariesLayer } from "./library/portable.js";
import { layer as librarySnapshotsLayer } from "./library/snapshots.js";
import { databaseLayer, layer as bindingsLayer, type RuntimeEnv } from "./platform/cloudflare.js";
import { layer as nativeClockLayer } from "./platform/native-clock.js";
import { layer as nativeCryptoLayer } from "./platform/native-crypto.js";
import {
  bootstrapLayer as bootstrapRateLimiterLayer,
  patLayer as patRateLimiterLayer,
} from "./platform/rate-limiter.js";
import { layer as publicationServiceLayer } from "./publication/service.js";
import { layer as readinessLayer } from "./readiness/service.js";
import { layer as releaseStoreLayer } from "./releases/store.js";
import { layer as skitDeletionLayer } from "./skit-delete/service.js";
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
    bindingsLayer(env),
    databaseLayer(env.DB),
    BrowserCrypto.layer,
    nativeCryptoLayer,
    nativeClockLayer,
  );
  const release = releaseStoreLayer.pipe(Layer.provide(platform));
  if (configured === undefined) return { release, authenticated: undefined, bootstrap: undefined };

  const passwordHasher = passwordHasherLayer.pipe(Layer.provideMerge(platform));
  const authenticated = Layer.mergeAll(
    authenticationLayer(supportedScopes),
    teamsLayer,
    librariesLayer,
    librarySnapshotsLayer,
    portableLibrariesLayer,
    readinessLayer(env),
    releaseStoreLayer,
    authorInventoryLayer,
    skitDeletionLayer,
    draftsLayer,
    publicationServiceLayer,
    patRateLimiterLayer(env.PAT_RATE_LIMITER),
    Layer.succeed(ServerConfiguration, { publicAppOrigin: configured.publicAppOrigin }),
  ).pipe(
    Layer.provideMerge(
      betterAuthLayer({
        publicAppOrigin: configured.publicAppOrigin,
        secret: configured.betterAuthSecret,
        registrationMode: env.ACCOUNT_REGISTRATION_MODE,
        github: configured.github,
        email:
          env.EMAIL && env.EMAIL_FROM ? { binding: env.EMAIL, from: env.EMAIL_FROM } : undefined,
      }).pipe(Layer.provideMerge(platform)),
    ),
    Layer.provideMerge(authorizationLayer.pipe(Layer.provideMerge(platform))),
    Layer.provideMerge(passwordHasher),
  );
  const bootstrap = env.SKIT_BOOTSTRAP_SECRET
    ? Layer.mergeAll(
        bootstrapServiceLayer(env.SKIT_BOOTSTRAP_SECRET),
        bootstrapRateLimiterLayer(env.BOOTSTRAP_RATE_LIMITER),
        Layer.succeed(ServerConfiguration, { publicAppOrigin: configured.publicAppOrigin }),
      ).pipe(Layer.provideMerge(passwordHasher))
    : undefined;
  return { release, authenticated, bootstrap };
};
