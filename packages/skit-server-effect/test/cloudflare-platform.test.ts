import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Bindings, blobStorageEffect, databaseLayer } from "../src/platform/cloudflare.js";

const testLayer = Layer.merge(
  Layer.succeed(Bindings, { database: env.DB, blobs: env.SKIT_BLOBS }),
  databaseLayer(env.DB),
);

describe("Cloudflare platform", () => {
  it.effect("reads and writes through the real R2 binding", () =>
    Effect.gen(function* () {
      yield* blobStorageEffect("write test object", (blobs) => blobs.put("platform-test", "hello"));
      const object = yield* blobStorageEffect("read test object", (blobs) =>
        blobs.get("platform-test"),
      );

      expect(object).not.toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );
});
