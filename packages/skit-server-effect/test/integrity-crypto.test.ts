import { BrowserCrypto } from "@effect/platform-browser";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { encodeHashParts, sha256 } from "../src/integrity/crypto.js";

describe("Integrity crypto", () => {
  it.effect("uses the Effect Crypto service for SHA-256", () =>
    Effect.gen(function* () {
      const digest = yield* sha256(new TextEncoder().encode("abc"));

      expect(digest).toBe(
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );

  it.effect("frames hash parts without ambiguous concatenation", () =>
    Effect.gen(function* () {
      const left = yield* sha256(encodeHashParts(["ab", "c"]));
      const right = yield* sha256(encodeHashParts(["a", "bc"]));

      expect(left).not.toBe(right);
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  );
});
