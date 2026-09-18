import { Effect, Layer, Stream } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
} from "effect/unstable/http";
import { FetchHttpClient } from "effect/unstable/http";

export type TestHttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => Response | Promise<Response>;

/**
 * Stub the transport at the `HttpClient` service.
 *
 * Not at `FetchHttpClient.Fetch`: that is a `Context.Reference` resolved from the *executing*
 * fiber's context, so an outer application Layer silently wins over one provided beneath the
 * client — and its default is computed once and cached on the Reference for the life of the
 * process (`Context.ts:1585`), which is why a `vi.stubGlobal("fetch", …)` installed later is
 * never seen. A client built here is the object the caller's Layer hands out, so nothing
 * outside it can take over.
 *
 * The real abort signal is forwarded, so interruption and streaming stay production's.
 */
/** The one place a test Promise becomes an Effect; every test client goes through it. */
const clientFrom = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    signal: AbortSignal,
    body: BodyInit | undefined,
  ) => Promise<Response> | Response,
): HttpClient.HttpClient =>
  HttpClient.make((request, url, signal) => {
    const send = (body: BodyInit | undefined) =>
      Effect.map(
        Effect.tryPromise({
          try: async () => answer(request, url, signal, body),
          catch: (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause }),
            }),
        }),
        (response) => HttpClientResponse.fromWeb(request, response),
      );
    switch (request.body._tag) {
      case "Raw":
      case "Uint8Array":
        return send(request.body.body as BodyInit);
      case "FormData":
        return send(request.body.formData);
      case "Stream":
        return Effect.flatMap(Stream.toReadableStreamEffect(request.body.stream), send);
    }
    return send(undefined);
  });

/** Serve a test's `fetch`-shaped handler as the application's HTTP client. */
export const fetchTestClientLayer = (fetcher: typeof globalThis.fetch) =>
  Layer.succeed(
    HttpClient.HttpClient,
    clientFrom((request, url, signal, body) =>
      fetcher(url, { method: request.method, headers: request.headers, body, signal }),
    ),
  );

/** The same, for a handler that reads the Effect request rather than a `RequestInit`. */
export const testHttpClientLayer = (handler: TestHttpHandler) =>
  Layer.succeed(
    HttpClient.HttpClient,
    clientFrom((request) => handler(request)),
  );

/** Preserve the production URL through policy validation, then route its path to the test server. */
export const productionUrlTestClient = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.effect(
      HttpClient.HttpClient,
      HttpClient.HttpClient.pipe(
        Effect.map((client) =>
          HttpClient.mapRequest(client, (request) => {
            const url = new URL(request.url);
            return HttpClientRequest.setUrl(request, `${url.pathname}${url.search}`);
          }),
        ),
      ),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
  ),
);
