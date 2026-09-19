import { BrowserCrypto } from "@effect/platform-browser";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { applicationLayers, authenticationConfiguration } from "./application.js";
import { principalAuthenticationLayer } from "./api/authentication.js";
import {
  AuthoringAuthenticatedApi,
  ConsumerAuthenticatedApi,
  PublicationAuthenticatedApi,
} from "./api/authenticated.js";
import { authorInventoryHandlers } from "./api/author-inventory-http.js";
import { bootstrapHandlers } from "./api/bootstrap-http.js";
import { BootstrapApi } from "./api/bootstrap.js";
import { draftHandlers } from "./api/drafts-http.js";
import { libraryHandlers } from "./api/libraries-http.js";
import { librarySnapshotHandlers } from "./api/library-snapshots-http.js";
import { librarySyncHandlers } from "./api/library-sync-http.js";
import { readinessHandlers } from "./api/readiness-http.js";
import { publicationHandlers } from "./api/publication-http.js";
import { requestDecodingLayer } from "./api/request-decoding.js";
import { anonymousReleaseHandlers, authenticatedReleaseHandlers } from "./api/releases-http.js";
import { ReleaseApi } from "./api/releases.js";
import { skitDeleteHandlers } from "./api/skit-delete-http.js";
import { makeSystemHandlers, systemApi } from "./api/system-http.js";
import { teamHandlers } from "./api/teams-http.js";
import { tokenHandlers } from "./api/tokens-http.js";
import { handleRequest as handleAuthRequest, handleUsernameClaim } from "./auth/better-auth.js";
import type { RuntimeEnv } from "./platform/cloudflare.js";
import { artifactResponse, indexResponse } from "./releases/agent-skills-http.js";
import { makeServerDiscovery, type ServerCapabilities } from "./discovery.js";

type ApplicationLayers = ReturnType<typeof applicationLayers>;
type ReleaseApplication = ApplicationLayers["release"];
type AuthenticatedApplication = NonNullable<ApplicationLayers["authenticated"]>;
type BootstrapApplication = NonNullable<ApplicationLayers["bootstrap"]>;

const allServerCapabilities: ServerCapabilities = {
  authoring: true,
  publication: true,
  library: true,
};

const methodNotAllowed = HttpServerResponse.json(
  { error: "method_not_allowed" },
  { status: 405, headers: { "cache-control": "no-store" } },
).pipe(Effect.orDie);

const configurationFailure = (detail: string) =>
  HttpServerResponse.json(
    { error: "configuration_error", detail },
    { status: 503, headers: { "cache-control": "no-store" } },
  ).pipe(Effect.orDie);

const downloadMethodRoutes = () =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.addAll([
        HttpRouter.route(
          "HEAD",
          "/api/skits/:owner/:slug/releases/:version/download",
          methodNotAllowed,
        ),
      ]);
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)
        yield* router.add(
          method,
          "/api/skits/:owner/:slug/releases/:version/download",
          methodNotAllowed,
        );
    }),
  );

const authenticatedReleaseApi = (application: AuthenticatedApplication) =>
  HttpApiBuilder.layer(ReleaseApi).pipe(
    Layer.provide(authenticatedReleaseHandlers.pipe(Layer.provide(application))),
    Layer.provide(HttpServer.layerServices),
  );

const anonymousReleaseApi = (application: ReleaseApplication) =>
  HttpApiBuilder.layer(ReleaseApi).pipe(
    Layer.provide(anonymousReleaseHandlers.pipe(Layer.provide(application))),
    Layer.provide(HttpServer.layerServices),
  );

const agentSkillsRoutes = (application: ReleaseApplication) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const indexPath = "/:owner/:slug/.well-known/agent-skills/index.json";
      const artifactPath = "/:owner/:slug/skills/:skill/skill.zip";
      yield* router.addAll([
        HttpRouter.route(
          "GET",
          indexPath,
          indexResponse.pipe(Effect.provide(Layer.merge(application, BrowserCrypto.layer))),
        ),
        HttpRouter.route(
          "GET",
          artifactPath,
          artifactResponse.pipe(Effect.provide(Layer.merge(application, BrowserCrypto.layer))),
        ),
        HttpRouter.route("HEAD", indexPath, methodNotAllowed),
        HttpRouter.route("HEAD", artifactPath, methodNotAllowed),
      ]);
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)
        for (const path of [indexPath, artifactPath] as const)
          yield* router.add(method, path, methodNotAllowed);
    }),
  );

const authenticatedRoutes = (env: RuntimeEnv) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add("*", "/api/auth/*", handleAuthRequest(env));
    }),
  );

const onboardingRoutes = (env: RuntimeEnv, application: AuthenticatedApplication) =>
  HttpRouter.use((router) =>
    router.add(
      "POST",
      "/api/onboarding/username",
      handleUsernameClaim(env).pipe(Effect.provide(application)),
    ),
  );

const uiConfigurationRoutes = (env: RuntimeEnv) =>
  HttpRouter.use((router) =>
    router.add(
      "GET",
      "/api/ui/config",
      HttpServerResponse.json(
        {
          github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          email: Boolean(env.EMAIL && env.EMAIL_FROM),
          registration: env.ACCOUNT_REGISTRATION_MODE === "open",
        },
        { headers: { "cache-control": "no-store" } },
      ).pipe(Effect.orDie),
    ),
  );

const configuredBootstrapRoutes = (
  application: BootstrapApplication,
  authentication: AuthenticatedApplication,
) =>
  HttpApiBuilder.layer(BootstrapApi).pipe(
    Layer.provide(bootstrapHandlers.pipe(Layer.provide(Layer.merge(application, authentication)))),
    Layer.provide(HttpServer.layerServices),
  );

const invalidBootstrapRoutes = (detail: string) =>
  HttpRouter.use((router) => {
    const response = configurationFailure(detail);
    return router.addAll([
      HttpRouter.route("GET", "/api/bootstrap/status", response),
      HttpRouter.route("POST", "/api/bootstrap", response),
    ]);
  });

const invalidAuthenticatedRoutes = (detail: string) =>
  HttpRouter.use((router) =>
    router.addAll([
      HttpRouter.route("*", "/api/auth/*", configurationFailure(detail)),
      HttpRouter.route("*", "/api/*", configurationFailure(detail)),
    ]),
  );

const consumerAuthenticatedApi = (application: AuthenticatedApplication) => {
  const handlers = Layer.mergeAll(
    tokenHandlers,
    teamHandlers,
    libraryHandlers,
    librarySnapshotHandlers,
    librarySyncHandlers,
    readinessHandlers,
  ).pipe(Layer.provide(application));
  return HttpApiBuilder.layer(ConsumerAuthenticatedApi).pipe(
    Layer.provide(handlers),
    Layer.provide(principalAuthenticationLayer.pipe(Layer.provide(application))),
    Layer.provide(requestDecodingLayer),
    Layer.provide(HttpServer.layerServices),
  );
};

const authoringAuthenticatedApi = (application: AuthenticatedApplication) => {
  const handlers = Layer.mergeAll(authorInventoryHandlers, draftHandlers, skitDeleteHandlers).pipe(
    Layer.provide(application),
  );
  return HttpApiBuilder.layer(AuthoringAuthenticatedApi).pipe(
    Layer.provide(handlers),
    Layer.provide(principalAuthenticationLayer.pipe(Layer.provide(application))),
    Layer.provide(requestDecodingLayer),
    Layer.provide(HttpServer.layerServices),
  );
};

const publicationAuthenticatedApi = (application: AuthenticatedApplication) =>
  HttpApiBuilder.layer(PublicationAuthenticatedApi).pipe(
    Layer.provide(publicationHandlers.pipe(Layer.provide(application))),
    Layer.provide(principalAuthenticationLayer.pipe(Layer.provide(application))),
    Layer.provide(requestDecodingLayer),
    Layer.provide(HttpServer.layerServices),
  );

const routeLayer = (env: RuntimeEnv, capabilities: ServerCapabilities) => {
  const configured = authenticationConfiguration(env);
  const authenticatedConfigurationValue =
    configured._tag === "Configured" ? configured.value : undefined;
  const supportedScopes = new Set([
    ...(capabilities.library ? (["library:sync"] as const) : []),
    ...(capabilities.authoring ? (["authoring:write"] as const) : []),
    ...(capabilities.publication ? (["publication:write"] as const) : []),
  ]);
  const application = applicationLayers(env, authenticatedConfigurationValue, supportedScopes);
  const authentication = application.authenticated;
  const main =
    authentication && authenticatedConfigurationValue
      ? Layer.mergeAll(
          downloadMethodRoutes(),
          authenticatedReleaseApi(authentication),
          authenticatedRoutes(env),
          onboardingRoutes(env, authentication),
          capabilities.library ? consumerAuthenticatedApi(authentication) : Layer.empty,
          capabilities.authoring ? authoringAuthenticatedApi(authentication) : Layer.empty,
          capabilities.publication ? publicationAuthenticatedApi(authentication) : Layer.empty,
        ).pipe(HttpRouter.provideRequest(authentication))
      : Layer.merge(
          Layer.merge(downloadMethodRoutes(), anonymousReleaseApi(application.release)),
          configured._tag === "Invalid"
            ? invalidAuthenticatedRoutes(configured.detail)
            : Layer.empty,
        );
  const bootstrap = env.SKIT_BOOTSTRAP_SECRET
    ? configured._tag === "Configured"
      ? application.bootstrap && authentication
        ? configuredBootstrapRoutes(application.bootstrap, authentication)
        : Layer.empty
      : invalidBootstrapRoutes(configured.detail)
    : Layer.empty;
  const typedSystem = systemApi.pipe(
    Layer.provide(makeSystemHandlers(makeServerDiscovery(capabilities))),
    Layer.provide(HttpServer.layerServices),
  );
  return Layer.mergeAll(
    typedSystem,
    uiConfigurationRoutes(env),
    agentSkillsRoutes(application.release),
    main,
    bootstrap,
  );
};

export const makeWebHandler = (
  env: RuntimeEnv,
  capabilities: ServerCapabilities = allServerCapabilities,
): {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
} => HttpRouter.toWebHandler(routeLayer(env, capabilities));
