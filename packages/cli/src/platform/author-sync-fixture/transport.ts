import { ConfigProvider, Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientResponse,
  type HttpClientError,
  type HttpClientRequest,
} from "effect/http";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";

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

/**
 * The SKIT configuration of a shell whose environment holds a token for `origin` only, as
 * `SKIT_SERVER_URL` and `SKIT_TOKEN`. A command sends it to that Registry and to no other.
 */
export const registryCredentialLayer = (origin: string, token = "test-token") =>
  skitConfigurationLayer().pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ SKIT_SERVER_URL: origin, SKIT_TOKEN: token }),
      ),
    ),
  );
