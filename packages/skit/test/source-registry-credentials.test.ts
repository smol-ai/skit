// Which requests carry the Registry credential, and where it must not follow.
//
// Acquisition sends `authorization` only for a Registry source, and only when a token was
// selected. A Registry download is also allowed to redirect, and the credential must not travel
// to whatever origin it lands on — a redirect is attacker-influenceable whenever the Registry is.
//
// Two disposable loopback servers, no public network. The archive body is a real zip, so the
// success path completes rather than failing before the header would matter.
//
// Whether the header is sent is ours and is checked here. That it is *dropped* across the
// redirect is the fetch implementation's guarantee rather than ours; asserting it makes the
// dependency explicit, so hand-rolling redirect following later would have to re-establish it.
// The remaining precedence case — a non-Registry https source never receiving the credential —
// is not reachable over loopback, because the classifier rejects a non-https URL source before
// acquisition; it holds by construction at the one `headers:` expression.

import { it } from "@effect/vitest";
import { assert, describe } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { createSkitArchiveEffect } from "../src/authoring/archive.js";
import { initSkitEffect } from "../src/authoring/scaffold.js";
import { skitLayer } from "../src/platform/layer.js";

const archive = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-credentials-" });
    const source = join(root, "tools");
    yield* initSkitEffect(source);
    const path = join(root, "tools.zip");
    yield* createSkitArchiveEffect(source, path);
    return yield* fs.readFile(path);
  }),
);

const listen = (server: Server) =>
  Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed((server.address() as AddressInfo).port));
    });
  });

const close = (server: Server) =>
  Effect.callback<void, Error>((resume) => {
    server.close((error) => resume(error ? Effect.fail(error) : Effect.void));
  }).pipe(Effect.orDie);

describe("the Registry credential", () => {
  it.effect("reaches the Registry and no origin it redirects to", () =>
    Effect.gen(function* () {
      const body = yield* archive;
      const seen: Array<[string, string | null]> = [];
      const downstream = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            seen.push(["downstream", request.headers.authorization ?? null]);
            response.writeHead(200, { "content-type": "application/zip" }).end(body);
          }),
        ),
        close,
      );
      const downstreamPort = yield* listen(downstream);
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            seen.push(["registry", request.headers.authorization ?? null]);
            response
              .writeHead(302, {
                location: `http://127.0.0.1:${downstreamPort}/objects/tools.zip`,
              })
              .end();
          }),
        ),
        close,
      );
      const registryPort = yield* listen(registry);
      yield* resolveSkitSourceEffect("skit:alice/tools", {
        registryBaseUrl: `http://127.0.0.1:${registryPort}`,
        registryToken: "secret-token",
        version: "1.0.0",
      });
      assert.deepEqual(seen, [
        ["registry", "Bearer secret-token"],
        // Dropped crossing origins, so a redirect cannot disclose it.
        ["downstream", null],
      ]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );

  it.effect("is absent when no token was selected", () =>
    Effect.gen(function* () {
      const body = yield* archive;
      const seen: Array<string | null> = [];
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() =>
          createServer((request, response) => {
            seen.push(request.headers.authorization ?? null);
            response.writeHead(200, { "content-type": "application/zip" }).end(body);
          }),
        ),
        close,
      );
      const port = yield* listen(registry);
      yield* resolveSkitSourceEffect("skit:alice/tools", {
        registryBaseUrl: `http://127.0.0.1:${port}`,
        version: "1.0.0",
      });
      assert.deepEqual(seen, [null]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
});
