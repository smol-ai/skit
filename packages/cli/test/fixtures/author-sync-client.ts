import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Ref, Result, Schema } from "effect";
import * as Library from "@smolai/skit-core/library";
import {
  authorLayer,
  refreshAuthorWorkspace,
  watchAuthorWorkspace,
} from "@smolai/skit-core/author";
import { authorRegistry } from "../../src/registry/author-sync.js";
import { join } from "node:path";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { syncAuthorWorkspace } from "../../src/author/sync/workflow.js";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { testRoots } from "../helpers/roots.js";

const Arguments = Schema.Struct({
  mode: Schema.Literals([
    "capture",
    "sync",
    "sync-count-posts",
    "hold-post",
    "watch-hold-post",
    "watch-offline",
  ]),
  root: Schema.String,
  home: Schema.String,
  first: Schema.Boolean,
  destination: Schema.String,
});

// A process boundary for real Registry E2E proof. This is not an additional shipped CLI command.
NodeRuntime.runMain(
  Effect.gen(function* () {
    const { mode, root, home, first, destination } = yield* Schema.decodeUnknownEffect(Arguments)({
      mode: process.argv[2],
      root: process.argv[3],
      home: process.argv[4],
      first: process.argv[5] === "first",
      destination: process.argv[6] ?? "",
    });
    const offlineOrigin =
      mode === "watch-offline"
        ? (yield* Schema.decodeUnknownEffect(Schema.URLFromString)(
            process.env.SKIT_TEST_OFFLINE_ORIGIN,
          )).origin
        : undefined;
    const registryOrigin = process.env.SKIT_SERVER_URL ?? "";
    const posts = yield* Ref.make(0);
    const transport =
      mode === "hold-post" ||
      mode === "watch-hold-post" ||
      mode === "watch-offline" ||
      mode === "sync-count-posts"
        ? Layer.effect(
            HttpClient.HttpClient,
            Effect.map(HttpClient.HttpClient, (client) =>
              mode === "sync-count-posts"
                ? HttpClient.transform(client, (response, request) =>
                    Effect.gen(function* () {
                      if (
                        request.method === "POST" &&
                        new URL(request.url).pathname.endsWith("/revisions")
                      )
                        yield* Ref.update(posts, (count) => count + 1);
                      return yield* response;
                    }),
                  )
                : mode === "watch-offline" && offlineOrigin !== undefined
                  ? // API clients append their base URL during preprocessing. Gate the final
                    // request, after that step, and never evaluate the real Registry request.
                    HttpClient.transform(client, (_response, request) =>
                      client.execute(
                        HttpClientRequest.setUrl(
                          request,
                          request.url.replace(registryOrigin, offlineOrigin),
                        ),
                      ),
                    )
                  : HttpClient.tap(client, (response) =>
                      response.status === 200 &&
                      response.request.method === "POST" &&
                      new URL(response.request.url).pathname.endsWith("/revisions")
                        ? Console.log(JSON.stringify({ event: "revision-accepted" })).pipe(
                            Effect.andThen(Effect.never),
                          )
                        : Effect.void,
                    ),
            ),
          ).pipe(Layer.provide(FetchHttpClient.layer))
        : FetchHttpClient.layer;
    const operation = Effect.gen(function* () {
      if (mode === "capture") {
        const observation = yield* refreshAuthorWorkspace(root);
        return { id: observation.id, treeHash: observation.treeHash };
      }
      if (mode === "watch-hold-post" || mode === "watch-offline")
        return yield* watchAuthorWorkspace(root, { home }, authorRegistry(home), (event) =>
          Console.log(JSON.stringify({ data: event })),
        ).pipe(
          Effect.provide(
            Library.layer({
              home,
              roots: {
                home: join(home, "device"),
                configHome: join(home, "device", ".config"),
                overrides: {},
              },
            }).pipe(Layer.provideMerge(registryHttpLayer(transport))),
          ),
        );
      return yield* syncAuthorWorkspace(root, {
        apply: true,
        home,
        ...(first ? { to: destination, visibility: "private" as const } : {}),
      }).pipe(
        Effect.provide(
          Library.layer({ home, roots: testRoots(home) }).pipe(
            Layer.provideMerge(registryHttpLayer(transport)),
          ),
        ),
      );
    });
    const outcome = yield* operation.pipe(
      Effect.provide(
        authorLayer({ home }).pipe(
          Layer.provideMerge(skitConfigurationLayer(home)),
          Layer.provideMerge(skitLayer),
        ),
      ),
      Effect.scoped,
      Effect.result,
    );
    yield* Console.log(
      JSON.stringify(
        Result.isSuccess(outcome)
          ? {
              _tag: "Success",
              value: outcome.success,
              ...(mode === "sync-count-posts" ? { posts: yield* Ref.get(posts) } : {}),
            }
          : {
              _tag: "Failure",
              failure: {
                tag: "_tag" in outcome.failure ? String(outcome.failure._tag) : "SkitFailure",
                message: outcome.failure.message,
              },
            },
      ),
    );
  }),
);
