import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type { HttpClientRequest } from "effect/unstable/http";
import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { authLogoutCommand } from "../src/registry/auth.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { rendererTestLayer } from "./helpers/renderer.js";

it.effect("revokes and forgets a credential through the application Layer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-auth-logout-" });
    const origin = "https://registry.example";
    yield* fs.writeFileString(
      join(home, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeOrigin: origin,
        servers: {
          [origin]: {
            token: "secret",
            tokenId: "token-id",
            tokenPrefix: "secret",
            scopes: ["authoring:write"],
          },
        },
      }),
    );
    const statuses: string[] = [];
    let request: HttpClientRequest.HttpClientRequest | undefined;
    const registry = testHttpClientLayer((incoming) => {
      request = incoming;
      return new Response(null, { status: 204 });
    });
    const applicationLayer = Layer.mergeAll(
      skitLayer,
      registryHttpLayer(registry),
      rendererTestLayer({
        withStatus: (status, operation) =>
          Effect.sync(() =>
            statuses.push(typeof status === "string" ? status : status.pending),
          ).pipe(Effect.andThen(operation)),
      }),
    );
    const value = yield* authLogoutCommand(home).pipe(Effect.provide(applicationLayer));
    assert.isDefined(request);
    assert.strictEqual(request.method, "DELETE");
    assert.strictEqual(request.headers["authorization"], "Bearer secret");
    assert.strictEqual(request.url, `${origin}/api/tokens/token-id`);
    assert.deepStrictEqual(value, { origin, revoked: true });
    assert.deepStrictEqual(statuses, ["Revoking CLI credential"]);
    const stored = JSON.parse(yield* fs.readFileString(join(home, "auth.json")));
    assert.deepStrictEqual(stored.servers, {});
  }).pipe(Effect.provide(skitLayer)),
);
