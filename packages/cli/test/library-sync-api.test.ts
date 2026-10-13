import { Effect } from "effect";
import { assert, it } from "@effect/vitest";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import { librarySyncApiEffect } from "../src/workflows/library/library-sync-api.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";

it.effect("retains an undeclared response status without inventing an error code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const api = yield* librarySyncApiEffect({
        origin: "https://registry.test",
        token: "test-token",
      });
      const failure = yield* Effect.flip(api.read());

      assert.strictEqual(failure._tag, "Library.LibraryApiRejected");
      if (failure._tag === "Library.LibraryApiRejected") {
        assert.strictEqual(failure.status, 502);
        assert.isFalse(Object.hasOwn(failure, "reason"));
      }
    }).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer(() => Effect.succeed(new Response("gateway", { status: 502 }))),
        ),
      ),
    ),
  ),
);

it.effect("rejects an undecodable remote Library instead of returning it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const api = yield* librarySyncApiEffect({
        origin: "https://registry.test",
        token: "test-token",
      });
      const failure = yield* Effect.flip(api.read());

      assert.strictEqual(failure._tag, "Library.LibraryApiInvalidResponse");
    }).pipe(
      Effect.provide(
        registryHttpLayer(
          testHttpClientLayer(() =>
            Effect.succeed(
              Response.json({
                library: {
                  library_id: "library_test",
                  revision_id: "revision_unknown",
                  manifest: { schema: "skit.library.unknown" },
                },
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);
