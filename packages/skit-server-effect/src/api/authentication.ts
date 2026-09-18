import {
  CurrentPrincipal,
  CurrentRequest,
  PrincipalAuthentication,
} from "@smolai/skit-core/universal/api";
import { Effect, Layer } from "effect";
import { Authentication } from "../auth/authentication.js";
import { authenticateRequest } from "../auth/request-context.js";
import { storageFailureResponse, unauthorizedResponse } from "./errors.js";
import { noStore } from "./response.js";

export { CurrentPrincipal, CurrentRequest, PrincipalAuthentication };

export const principalAuthenticationLayer = Layer.effect(
  PrincipalAuthentication,
  Effect.gen(function* () {
    const authentication = yield* Authentication;
    return PrincipalAuthentication.of((effect) =>
      noStore.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { principal, request } = yield* authenticateRequest().pipe(
              Effect.provideService(Authentication, authentication),
              Effect.tapError((error) => Effect.logError("request authentication failed", error)),
              Effect.mapError(() => storageFailureResponse),
            );
            if (principal === undefined) return yield* Effect.fail(unauthorizedResponse);
            return yield* effect.pipe(
              Effect.provideService(CurrentPrincipal, principal),
              Effect.provideService(CurrentRequest, request),
            );
          }),
        ),
      ),
    );
  }),
);
