import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Result, Schema } from "effect";
import * as Library from "@smolai/skit-core/library";
import { authorLayer, captureAuthorWorkspace } from "@smolai/skit-core/author";
import { skitConfigurationLayer, skitLayer } from "@smolai/skit-core/platform";
import { syncAuthorWorkspace } from "../../src/author/sync/workflow.js";
import { registryHttpLayer } from "../../src/registry/registry-http.js";
import { FetchHttpClient, HttpClient } from "effect/http";

const Arguments = Schema.Struct({
  mode: Schema.Literals(["capture", "sync", "hold-post"]),
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
    const transport =
      mode === "hold-post"
        ? Layer.effect(
            HttpClient.HttpClient,
            Effect.map(HttpClient.HttpClient, (client) =>
              HttpClient.tap(client, (response) =>
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
        const observation = yield* captureAuthorWorkspace(root);
        return { id: observation.id, treeHash: observation.treeHash };
      }
      return yield* syncAuthorWorkspace(root, {
        apply: true,
        home,
        ...(first ? { to: destination, visibility: "private" as const } : {}),
      }).pipe(
        Effect.provide(Library.layer({ home, routing: { _tag: "None" } })),
        Effect.provide(registryHttpLayer(transport)),
      );
    });
    const outcome = yield* operation.pipe(
      Effect.provide(authorLayer({ home })),
      Effect.provide(skitConfigurationLayer(home)),
      Effect.provide(skitLayer),
      Effect.scoped,
      Effect.result,
    );
    yield* Console.log(
      JSON.stringify(
        Result.isSuccess(outcome)
          ? { _tag: "Success", value: outcome.success }
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
