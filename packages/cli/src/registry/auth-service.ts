import { Context, Effect, Layer, Result } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
  resolveAuthEffect,
  resolveRegistryLocatorEffect,
  type RegistryConfigurationError,
  type ResolvedAuth,
} from "./auth.js";

export interface RegistryAuthAccess {
  readonly authState: Result.Result<ResolvedAuth, RegistryConfigurationError>;
  readonly origin?: string;
  readonly token?: string;
  readonly configurationError?: RegistryConfigurationError;
}

const accessFrom = (
  authState: Result.Result<ResolvedAuth, RegistryConfigurationError>,
): RegistryAuthAccess => {
  const auth = Result.isSuccess(authState) ? authState.success : undefined;
  return {
    authState,
    ...(auth?.origin === undefined ? {} : { origin: auth.origin }),
    ...(auth?.token === undefined ? {} : { token: auth.token }),
    ...(Result.isFailure(authState) ? { configurationError: authState.failure } : {}),
  };
};

export interface RegistryAuth {
  readonly resolve: (
    registry?: string,
    command?: string,
  ) => Effect.Effect<RegistryAuthAccess, never, FileSystem>;
  readonly resolveLocator: (
    input: string,
    registry?: string,
  ) => ReturnType<typeof resolveRegistryLocatorEffect>;
}

const noRegistryAccess: RegistryAuthAccess = { authState: Result.succeed({ source: "none" }) };

export const RegistryAuth = Context.Reference<RegistryAuth>("skit/services/RegistryAuth", {
  defaultValue: () => ({
    resolve: () => Effect.succeed(noRegistryAccess),
    resolveLocator: (input) => Effect.succeed({ input }),
  }),
});

/** Read ambient Registry configuration at most once per command runtime. */
export const registryAuthLayer = (home: string) =>
  Layer.effect(
    RegistryAuth,
    Effect.gen(function* () {
      const ambient = yield* Effect.cached(
        resolveAuthEffect(home).pipe(Effect.result, Effect.map(accessFrom)),
      );
      return {
        resolve: (registry, command) =>
          registry === undefined && command === undefined
            ? ambient
            : resolveAuthEffect(home, registry, undefined, command).pipe(
                Effect.result,
                Effect.map(accessFrom),
              ),
        resolveLocator: (input, registry) =>
          resolveRegistryLocatorEffect(input, {
            home,
            ...(registry === undefined ? {} : { registry }),
          }),
      } satisfies RegistryAuth;
    }),
  );

export const registryAuthAccessLayer = (access: RegistryAuthAccess) =>
  Layer.succeed(RegistryAuth, {
    resolve: () => Effect.succeed(access),
    resolveLocator: (input) => Effect.succeed({ input }),
  });
