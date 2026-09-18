import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { PasswordHasher, layer } from "../src/auth/password.js";
import { NativeCrypto, layer as nativeCryptoLayer } from "../src/platform/native-crypto.js";

const passwordLayer = layer.pipe(Layer.provide(nativeCryptoLayer));

const LEGACY_FIXTURE = "AAECAwQFBgcICQoLDA0OD0nUnCX1l4RiCfDZLndwq2Thx16UtM5sUJJl7mcXXSoe";

describe("PasswordHasher", () => {
  it.effect("verifies the legacy PBKDF2 storage format", () =>
    Effect.gen(function* () {
      const passwords = yield* PasswordHasher;

      expect(yield* passwords.verify("correct horse battery staple", LEGACY_FIXTURE)).toBe(true);
      expect(yield* passwords.verify("incorrect", LEGACY_FIXTURE)).toBe(false);
    }).pipe(Effect.provide(passwordLayer)),
  );

  it.effect("hashes a password into the legacy 48-byte envelope", () =>
    Effect.gen(function* () {
      const passwords = yield* PasswordHasher;
      const stored = yield* passwords.hash("password1234");

      expect(Uint8Array.from(atob(stored), (value) => value.charCodeAt(0))).toHaveLength(48);
      expect(yield* passwords.verify("password1234", stored)).toBe(true);
      expect(yield* passwords.verify("password123", stored)).toBe(false);
    }).pipe(Effect.provide(passwordLayer)),
  );

  it.effect("treats malformed stored credentials as non-matches", () =>
    Effect.gen(function* () {
      const passwords = yield* PasswordHasher;

      expect(yield* passwords.verify("password1234", "not base64!")).toBe(false);
      expect(yield* passwords.verify("password1234", btoa("too short"))).toBe(false);
    }).pipe(Effect.provide(passwordLayer)),
  );

  it.effect("keeps WebCrypto failures distinct from password mismatches", () =>
    Effect.gen(function* () {
      const subtle = new Proxy(globalThis.crypto.subtle, {
        get(target, property) {
          if (property === "importKey") return () => Promise.reject(new Error("crypto offline"));
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const brokenCrypto = new Proxy(globalThis.crypto, {
        get(target, property) {
          if (property === "subtle") return subtle;
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const outcome = yield* Effect.gen(function* () {
        const passwords = yield* PasswordHasher;
        return yield* Effect.result(passwords.verify("password", LEGACY_FIXTURE));
      }).pipe(Effect.provide(layer), Effect.provideService(NativeCrypto, brokenCrypto));

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure._tag).toBe("PasswordHasher.PasswordHashError");
    }),
  );
});
