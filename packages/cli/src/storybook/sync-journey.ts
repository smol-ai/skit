import { makeSyncJourneyFixture } from "../platform/storybook-fixtures.js";
import { Effect, Layer, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { join } from "node:path";
import * as Library from "@smolai/skit-core/library";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { LibraryResponse, SnapshotArchive, StorageFailureResponse } from "@smolai/skit-core/api";
import { librarySyncCommand } from "../library/sync.js";
import { result } from "../commands/result.js";
import { commandFailure } from "../commands/failure-classification.js";
import { Renderer } from "../terminal/renderer.js";
import { registryHttpLayer } from "../registry/registry-http.js";

/** Run the real sync command against a fixture Registry and disposable device homes. */
export const syncJourney = (failDownload: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { workspace, seeded } = yield* makeSyncJourneyFixture;
      const remote = {
        library_id: "library_story",
        revision_id: "revision_story",
        manifest: seeded.manifest,
      };
      let downloads = 0;
      const transport = registryHttpLayer(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const path = new URL(request.url).pathname;
              let response: Response;
              if (request.method === "GET" && path === "/api/library/portable") {
                response = Response.json(
                  yield* Schema.encodeEffect(LibraryResponse)({ library: remote }),
                );
              } else if (request.method === "GET" && path.startsWith("/api/libraries/")) {
                const hash = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
                const archive = seeded.archives.find((candidate) => candidate.digest === hash);
                downloads++;
                response =
                  failDownload && downloads === 2
                    ? Response.json(
                        yield* Schema.encodeEffect(StorageFailureResponse)({
                          error: "storage_failure",
                        }),
                        { status: 500 },
                      )
                    : archive
                      ? Response.json(yield* Schema.encodeEffect(SnapshotArchive)(archive))
                      : new Response(null, { status: 404 });
              } else {
                response = new Response(`Unexpected fixture request: ${request.method} ${path}`, {
                  status: 501,
                });
              }
              return HttpClientResponse.fromWeb(request, response);
            }).pipe(Effect.orDie),
          ),
        ),
      );
      const home = join(workspace, "fresh-device");
      const renderer = yield* Renderer;
      const synced = yield* librarySyncCommand({
        authState: Result.succeed({
          origin: "https://registry.fixture",
          token: "fixture",
          source: "stored",
        }),
        apply: true,
      }).pipe(
        // The fixture device's Library, routed as its installs.
        Effect.provide(
          Library.layer({
            home,
            roots: {
              home: workspace,
              configHome: workspace,
              overrides: { codex: [join(workspace, "agents-skills")] },
            },
          }).pipe(Layer.provideMerge(skitConfigurationLayer(home)), Layer.provideMerge(transport)),
        ),
        Effect.catchCause((cause) =>
          renderer.failure(commandFailure(cause)).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      );
      yield* renderer.result(result("librarySync", synced));
      return "3 Collections | 3 Skills | enabled on the fixture device";
    }),
  ).pipe(Effect.provide(skitLayer));
