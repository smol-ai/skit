import { Context, Data, Effect, Layer, Predicate, Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http";

export class RegistryTransportError extends Data.TaggedError("RegistryTransportError")<{
  cause: Error;
}> {
  get message() {
    return this.cause.message;
  }
}
export const isRegistryTransportError = (error: unknown): error is RegistryTransportError =>
  Predicate.isTagged(error, "RegistryTransportError");

export const registryClient = <R>(
  client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>,
): HttpClient.HttpClient.With<RegistryTransportError, R> =>
  HttpClient.transformResponse(
    client,
    Effect.mapError(
      (error) =>
        new RegistryTransportError({
          cause: new Error(error.message, { cause: error.reason.cause }),
        }),
    ),
  );
/** One scoped, never-retrying transport shared by generated and non-HttpApi clients. */
export class RegistryHttp extends Context.Service<
  RegistryHttp,
  {
    readonly client: Effect.Effect<
      HttpClient.HttpClient.With<RegistryTransportError>,
      never,
      Scope.Scope
    >;
  }
>()("skit/services/RegistryHttp") {}

export function registryHttpLayer(
  clientLayer: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
): Layer.Layer<RegistryHttp> {
  return Layer.effect(
    RegistryHttp,
    Effect.gen(function* () {
      // Use Effect's transport, request model and cancellation machinery. No status filtering or
      // retries: workflows interpret Registry statuses, and a write must never be retried implicitly.
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);
      return RegistryHttp.of({
        client: Effect.gen(function* () {
          const scope = yield* Effect.scope;
          return HttpClient.transformResponse(
            registryClient(client),
            Effect.provideService(Scope.Scope, scope),
          );
        }),
      });
    }),
  ).pipe(Layer.provide(clientLayer));
}
