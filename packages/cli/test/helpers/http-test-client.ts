import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServer,
} from "effect/http";
import { FetchHttpClient } from "effect/http";

export type TestHttpHandler = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  signal: AbortSignal,
) => Effect.Effect<Response, HttpClientError.HttpClientError>;

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
 * The handler is an Effect, so interrupting a pending request interrupts the handler: a test
 * observes that with `Effect.onInterrupt` and fails the transport with an `HttpClientError`.
 * Once a response is returned, its body is read through the web `Response`, which only the
 * request's `signal` can cancel — as fetch ties a body to its request — so a streaming body
 * observes cancellation there.
 */
export const testHttpClientLayer = (handler: TestHttpHandler) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) =>
      Effect.map(handler(request, url, signal), (response) =>
        HttpClientResponse.fromWeb(request, response),
      ),
    ),
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
