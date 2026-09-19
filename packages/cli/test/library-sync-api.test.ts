import { Effect, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { registryHttpLayer } from "../src/registry/registry-http.js";
import {
  LibraryApiRejected,
  librarySyncApiEffect,
} from "../src/workflows/library/library-sync-api.js";
import { testHttpClientLayer } from "./helpers/http-test-client.js";

it.effect("retains an undeclared response status without inventing an error code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const api = yield* librarySyncApiEffect({
        origin: "https://registry.test",
        token: "test-token",
      });
      const failure = yield* Effect.flip(api.read());

      assert.isTrue(Schema.is(LibraryApiRejected)(failure));
      if (Schema.is(LibraryApiRejected)(failure)) {
        assert.strictEqual(failure.status, 502);
        assert.isFalse(Object.hasOwn(failure, "code"));
      }
    }).pipe(
      Effect.provide(
        registryHttpLayer(testHttpClientLayer(() => new Response("gateway", { status: 502 }))),
      ),
    ),
  ),
);
