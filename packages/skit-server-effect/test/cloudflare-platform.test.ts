import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { BlobStore, blobStoreLayer } from "../src/platform/cloudflare.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("BlobStore", () => {
  it.effect("reads, writes and deletes through the real R2 binding", () =>
    Effect.gen(function* () {
      const blobs = yield* BlobStore;
      yield* blobs.probe();
      expect(yield* blobs.put("write test object", "platform-test", bytes("hello"))).toBe(true);
      expect(
        yield* blobs.put("rewrite test object", "platform-test", bytes("other"), {
          onlyIfAbsent: true,
        }),
      ).toBe(false);
      expect(yield* blobs.get("read test object", "platform-test")).toEqual(
        Option.some(bytes("hello")),
      );
      expect(yield* blobs.exists("find test object", "platform-test")).toBe(true);

      yield* blobs.delete("delete test object", ["platform-test"]);
      expect(yield* blobs.get("read deleted object", "platform-test")).toEqual(Option.none());
      expect(yield* blobs.exists("find deleted object", "platform-test")).toBe(false);
    }).pipe(Effect.provide(blobStoreLayer(env.SKIT_BLOBS))),
  );

  it.effect("deletes more keys than one R2 delete call accepts", () => {
    const bucket = env.SKIT_BLOBS;
    // Miniflare does not enforce this Workers API limit. Keep the request
    // boundary strict while forwarding the actual operations to the real binding.
    const limited: Pick<R2Bucket, "get" | "put" | "head" | "delete" | "list"> = {
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket),
      delete: (keys) =>
        Array.isArray(keys) && keys.length > 1_000
          ? Promise.reject(new Error("R2 accepts at most 1000 delete keys per request"))
          : bucket.delete(keys),
    };
    return Effect.gen(function* () {
      const blobs = yield* BlobStore;
      const keys = Array.from({ length: 1_001 }, (_, index) => `batch/${index}`);
      // R2 limits keys per request regardless of whether the objects exist.
      // Seed both sides of that boundary; the other keys need no upload.
      const stored = ["batch/0", "batch/999", "batch/1000"];
      yield* Effect.forEach(stored, (key) => blobs.put("write batch object", key, bytes(key)));

      yield* blobs.delete("delete batch objects", keys);
      for (const key of stored)
        expect(yield* blobs.exists("find remaining batch object", key)).toBe(false);
    }).pipe(Effect.provide(blobStoreLayer(limited)));
  });
});
