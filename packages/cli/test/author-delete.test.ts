import { testPlatformLayer } from "./helpers/platform.js";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Result } from "effect";
import { join } from "node:path";
import { HttpClientError } from "effect/http";
import { authorDeleteCommand } from "../src/author/delete.js";
import { deletePrivateAuthorSkit as deleteAuthorSkit } from "../src/registry/authoring.js";
import { DeleteRequiresPrivate } from "../src/registry/failures.js";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";
import { rendererTestLayer } from "./helpers/renderer.js";

const remote = {
  schema: "skit.remote.v1" as const,
  origin: "https://registry.example",
  namespace: "tim",
  skit: "tools",
};

it.effect("previews and deletes the selected private SKIT", () =>
  Effect.forEach([true, false], (dryRun) => {
    let request: { method: string; authorization?: string; url: string } | undefined;
    const registry = testHttpClientLayer((input, url) =>
      Effect.sync(() => {
        request = {
          method: input.method,
          authorization: input.headers["authorization"],
          url: url.href,
        };
        return Response.json({
          status: dryRun ? "delete_ready" : "deleted",
          skit_id: "tim/tools",
          changed: !dryRun,
          revisions: 2,
          releases: 1,
          release_versions: ["1.0.0"],
          ...(dryRun ? {} : { archive_cleanup: "complete" }),
        });
      }),
    );
    return Effect.gen(function* () {
      const value = yield* Effect.scoped(
        deleteAuthorSkit(remote, { token: "secret", dryRun }),
      ).pipe(Effect.provide(registryHttpLayer(registry)));
      assert.isDefined(request);
      assert.strictEqual(request.method, "DELETE");
      assert.strictEqual(request.authorization, "Bearer secret");
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
    Effect.succeed(Response.json({ error: "delete_requires_private" }, { status: 409 })),
  );
  return Effect.scoped(deleteAuthorSkit(remote, { token: "secret" })).pipe(
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
    const registry = testHttpClientLayer(() =>
      Effect.sync(() => {
        requests++;
        return Response.json({
          status: "deleted",
          skit_id: "tim/tools",
          changed: true,
          revisions: 2,
          releases: 1,
          release_versions: ["1.0.0"],
          archive_cleanup: "complete",
        });
      }),
    );
    const applicationLayer = Layer.mergeAll(
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
  }).pipe(Effect.provide(testPlatformLayer)),
);

it.effect.each([
  { status: 401, body: { error: "unauthorized" }, tag: "AuthenticationRequired" },
  { status: 403, body: { error: "insufficient_scope" }, tag: "CredentialLacksScope" },
  { status: 404, body: { error: "skit_not_found" }, tag: "AuthorSkitNotFound" },
  { status: 409, body: { error: "delete_requires_private" }, tag: "DeleteRequiresPrivate" },
  { status: 503, body: { error: "storage_failure" }, tag: "AuthorDeleteResponseError" },
  { status: 401, body: null, tag: "AuthorDeleteResponseError" },
  { status: 200, body: null, tag: "SkitContractError" },
])("classifies deletion status $status without retrying ($tag)", ({ status, body, tag }) =>
  Effect.gen(function* () {
    let requests = 0;
    const result = yield* Effect.result(
      Effect.scoped(deleteAuthorSkit(remote, { token: "test-token" })).pipe(
        Effect.provide(
          registryHttpLayer(
            testHttpClientLayer(() =>
              Effect.sync(() => {
                requests++;
                return Response.json(body, { status });
              }),
            ),
          ),
        ),
      ),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, tag);
    assert.strictEqual(requests, 1);
  }),
);

it.effect("a failed deletion transport preserves its failure without another request", () =>
  Effect.gen(function* () {
    let requests = 0;
    const failure = yield* Effect.flip(
      Effect.scoped(deleteAuthorSkit(remote, { token: "test-token" })).pipe(
        Effect.provide(
          registryHttpLayer(
            testHttpClientLayer((request) => {
              requests++;
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new TypeError("offline"),
                  }),
                }),
              );
            }),
          ),
        ),
      ),
    );
    assert.strictEqual(failure._tag, "RegistryUnreachable");
    assert.strictEqual(requests, 1);
  }),
);

it.effect.each(["request", "body"] as const)(
  "interrupting a deletion %s releases it without retry",
  (stage) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let requests = 0;
      let finalized = false;
      const effect = Effect.scoped(deleteAuthorSkit(remote, { token: "test-token" })).pipe(
        Effect.provide(
          registryHttpLayer(
            testHttpClientLayer((_request, _url, signal) => {
              requests++;
              if (stage === "body")
                return Effect.succeed(
                  new Response(
                    new ReadableStream(
                      {
                        pull(controller) {
                          signal.addEventListener(
                            "abort",
                            () => {
                              finalized = true;
                              controller.error(signal.reason);
                            },
                            { once: true },
                          );
                          Deferred.doneUnsafe(ready, Effect.void);
                        },
                      },
                      { highWaterMark: 0 },
                    ),
                  ),
                );
              return Deferred.succeed(ready, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    finalized = true;
                  }),
                ),
              );
            }),
          ),
        ),
      );
      const fiber = yield* effect.pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      assert.isTrue(finalized);
      assert.strictEqual(requests, 1);
    }),
);
