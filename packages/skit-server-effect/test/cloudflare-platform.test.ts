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

  it.effect("deletes more keys than one R2 delete call accepts", () =>
    Effect.gen(function* () {
      const blobs = yield* BlobStore;
      const keys = Array.from({ length: 1_001 }, (_, index) => `batch/${index}`);
      yield* Effect.forEach(keys, (key) => blobs.put("write batch object", key, bytes(key)), {
        concurrency: 50,
      });

      yield* blobs.delete("delete batch objects", keys);
      expect(yield* blobs.exists("find first batch object", keys[0] ?? "")).toBe(false);
      expect(yield* blobs.exists("find last batch object", keys[1_000] ?? "")).toBe(false);
    }).pipe(Effect.provide(blobStoreLayer(env.SKIT_BLOBS))),
  );
});
