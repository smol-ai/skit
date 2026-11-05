import { CurrentPrincipal, PrincipalAuthentication } from "@smolai/skit-core/universal/api";
import { Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/http";
import { Identity } from "../identity/service.js";
import { authenticateRequest } from "../identity/request-context.js";
import { forbiddenOriginResponse, storageFailureResponse, unauthorizedResponse } from "./errors.js";
import { ServerConfiguration } from "../configuration.js";
import { noStore } from "./response.js";

export { CurrentPrincipal, PrincipalAuthentication };

export const principalAuthenticationLayer = Layer.effect(
  PrincipalAuthentication,
  Effect.gen(function* () {
    const authentication = yield* Identity;
    const configuration = yield* ServerConfiguration;
    return PrincipalAuthentication.of((effect) =>
      noStore.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { principal } = yield* authenticateRequest().pipe(
              Effect.provideService(Identity, authentication),
              Effect.tapError((error) => Effect.logError("request authentication failed", error)),
              Effect.mapError(() => storageFailureResponse),
            );
            if (principal === undefined) return yield* Effect.fail(unauthorizedResponse);
            // A browser session may write only from SKIT's own site. Reads are exempt: browsers
            // do not always send Origin on same-site GETs. Tokens are not ambient credentials.
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (
              principal.credential === "session" &&
              request.method !== "GET" &&
              request.method !== "HEAD" &&
              request.headers.origin !== configuration.publicAppOrigin
            )
              return yield* Effect.fail(forbiddenOriginResponse);
            return yield* effect.pipe(Effect.provideService(CurrentPrincipal, principal));
          }),
        ),
      ),
    );
  }),
);
