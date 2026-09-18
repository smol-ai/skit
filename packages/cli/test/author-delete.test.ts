import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { authorDeleteCommand, deleteAuthorSkitEffect } from "../src/workflows/author/delete.js";
import { DeleteRequiresPrivate } from "../src/registry/failures.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { fetchTestClientLayer, testHttpClientLayer } from "./helpers/http-test-client.js";
import { rendererTestLayer } from "./helpers/renderer.js";

const remote = {
  schema: "skit.remote.v1" as const,
  origin: "https://registry.example",
  namespace: "tim",
  skit: "tools",
};

it.effect("previews and deletes the selected private SKIT", () =>
  Effect.forEach([true, false], (dryRun) => {
    let request: Request | undefined;
    const registry = fetchTestClientLayer(async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        status: dryRun ? "delete_ready" : "deleted",
        skit_id: "tim/tools",
        changed: !dryRun,
        draft_revisions: 2,
        releases: 1,
        release_versions: ["1.0.0"],
        ...(dryRun ? {} : { archive_cleanup: "complete" }),
      });
    });
    return Effect.gen(function* () {
      const value = yield* Effect.scoped(
        deleteAuthorSkitEffect(remote, { token: "secret", dryRun }),
      ).pipe(Effect.provide(registryHttpLayer(registry)));
      assert.isDefined(request);
      assert.strictEqual(request.method, "DELETE");
      assert.strictEqual(request.headers.get("authorization"), "Bearer secret");
      assert.strictEqual(
        request.url,
        `https://registry.example/api/skits/tim/tools${dryRun ? "?dry_run=true" : ""}`,
      );
      assert.strictEqual(value.status, dryRun ? "delete_ready" : "deleted");
    });
  }),
);

it.effect("refuses non-private deletion with a stable conflict", () => {
  const registry = testHttpClientLayer(() =>
    Response.json({ error: "delete_requires_private" }, { status: 409 }),
  );
  return Effect.scoped(deleteAuthorSkitEffect(remote, { token: "secret" })).pipe(
    Effect.provide(registryHttpLayer(registry)),
    Effect.flip,
    Effect.map((failure) => assert.instanceOf(failure, DeleteRequiresPrivate)),
  );
});

it.effect("runs destination, credential, status and DELETE as one application Effect", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-author-delete-" });
    yield* fs.writeFileString(
      join(home, "auth.json"),
      JSON.stringify({
        schemaVersion: 1,
        activeOrigin: remote.origin,
        servers: {
          [remote.origin]: {
            token: "secret",
            tokenId: "token-id",
            tokenPrefix: "secret",
            scopes: ["authoring:write"],
          },
        },
      }),
    );
    const statuses: string[] = [];
    let requests = 0;
    const registry = testHttpClientLayer(() => {
      requests++;
      return Response.json({
        status: "deleted",
        skit_id: "tim/tools",
        changed: true,
        draft_revisions: 2,
        releases: 1,
        release_versions: ["1.0.0"],
        archive_cleanup: "complete",
      });
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
    const value = yield* authorDeleteCommand("tim/tools", {
      authState: Result.succeed({ origin: remote.origin, source: "stored" }),
      home,
    }).pipe(Effect.provide(applicationLayer));
    assert.strictEqual(value.status, "deleted");
    assert.strictEqual(requests, 1);
    assert.deepStrictEqual(statuses, ["Deleting private SKIT"]);
  }).pipe(Effect.provide(skitLayer)),
);
