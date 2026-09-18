import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiTest } from "effect/unstable/httpapi";
import {
  CurrentPrincipal,
  CurrentRequest,
  PrincipalAuthentication,
} from "../src/api/authentication.js";
import { PublicationAuthenticatedApi } from "../src/api/authenticated.js";
import { publicationHandlers } from "../src/api/publication-http.js";
import { requestDecodingLayer } from "../src/api/request-decoding.js";
import { Authorization } from "../src/authorization/service.js";
import { ServerConfiguration } from "../src/configuration.js";
import { DatabaseError } from "../src/platform/cloudflare.js";
import { Publication, ReleaseConflict } from "../src/publication/service.js";

const principal = {
  id: "principal_test",
  credential: "session" as const,
  scopes: new Set(["publication:write" as const]),
};

const authentication = Layer.succeed(
  PrincipalAuthentication,
  PrincipalAuthentication.of((effect) =>
    effect.pipe(
      Effect.provideService(CurrentPrincipal, principal),
      Effect.provideService(
        CurrentRequest,
        new Request("https://registry.test/api/skits/tim/tools/releases", {
          method: "POST",
          headers: { origin: "https://registry.test" },
        }),
      ),
    ),
  ),
);

const dependencies = Layer.mergeAll(
  Layer.mock(Authorization, {
    canPublish: () => Effect.succeed(true),
  }),
  Layer.succeed(ServerConfiguration, { publicAppOrigin: "https://registry.test" }),
  Layer.succeed(
    Publication,
    Publication.of({
      publish: (input) =>
        input.version === "2.0.0"
          ? Effect.fail(new ReleaseConflict())
          : input.version === "3.0.0"
            ? Effect.fail(
                new DatabaseError({ operation: "publish test release", cause: "unavailable" }),
              )
            : Effect.succeed({
                release_id: "release_test",
                version: input.version,
                revision_id: "revision_test",
                archive_digest:
                  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              }),
    }),
  ),
);

const handlers = Layer.mergeAll(
  publicationHandlers.pipe(Layer.provide(dependencies)),
  HttpServer.layerServices,
).pipe(Layer.provideMerge(authentication), Layer.provideMerge(requestDecodingLayer));
const makeClient = HttpApiTest.groups(PublicationAuthenticatedApi, ["publication"]);

layer(handlers)("PublicationApi", (it) => {
  it.effect("publishes a decoded archive and exposes typed conflicts", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;

      expect(
        yield* client.publication.publish({
          params: { owner: "tim", slug: "tools" },
          payload: { version: "1.0.0", archive_base64: "" },
        }),
      ).toEqual({
        release: {
          release_id: "release_test",
          version: "1.0.0",
          revision_id: "revision_test",
          archive_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          download_path: "/api/skits/tim/tools/releases/1.0.0/download",
        },
      });

      expect(
        yield* Effect.flip(
          client.publication.publish({
            params: { owner: "tim", slug: "tools" },
            payload: { version: "2.0.0", archive_base64: "" },
          }),
        ),
      ).toEqual({ error: "release_conflict" });
    }),
  );

  it.effect("returns 500 when publication storage fails", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      const response = yield* client.publication.publish({
        params: { owner: "tim", slug: "tools" },
        payload: { version: "3.0.0", archive_base64: "" },
        responseMode: "response-only",
      });

      expect(response.status).toBe(500);
      expect(yield* response.json).toEqual({ error: "storage_failure" });
    }),
  );
});
