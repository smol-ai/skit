import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { hashPassword, passwordCallbacks } from "../src/identity/internal/password.js";
import { WebCrypto } from "effect/crypto";

const LEGACY_FIXTURE = "AAECAwQFBgcICQoLDA0OD0nUnCX1l4RiCfDZLndwq2Thx16UtM5sUJJl7mcXXSoe";

// Exercise the same Promise callbacks supplied to Better Auth.
const callbacks = passwordCallbacks(globalThis.crypto);

// Better Auth requires Promise verification callbacks; exercise that live host-facing API.
const verifyCallback = (password: string, hash: string) =>
  // oxlint-disable-next-line skit/no-promise-wrappers -- This test enters Better Auth's Promise-shaped password verification boundary.
  Effect.promise(() => callbacks.verify({ password, hash }));

describe("password hashing", () => {
  it.effect("verifies the legacy PBKDF2 storage format", () =>
    Effect.gen(function* () {
      expect(yield* verifyCallback("correct horse battery staple", LEGACY_FIXTURE)).toBe(true);
      expect(yield* verifyCallback("incorrect", LEGACY_FIXTURE)).toBe(false);
    }),
  );

  it.effect("hashes a password into the legacy 48-byte envelope", () =>
    Effect.gen(function* () {
      const stored = yield* hashPassword("password1234");
      expect(Uint8Array.from(atob(stored), (value) => value.charCodeAt(0))).toHaveLength(48);
      expect(yield* verifyCallback("password1234", stored)).toBe(true);
      expect(yield* verifyCallback("password123", stored)).toBe(false);
    }),
  );

  it.effect("treats malformed stored credentials as non-matches", () =>
    Effect.gen(function* () {
      expect(yield* verifyCallback("password1234", "not base64!")).toBe(false);
      expect(yield* verifyCallback("password1234", btoa("too short"))).toBe(false);
    }),
  );

  it.effect("maps hashing failures to the existing password error tag", () =>
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
      const outcome = yield* Effect.result(hashPassword("password")).pipe(
        Effect.provideService(WebCrypto.WebCrypto, brokenCrypto),
      );

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure")
        expect(outcome.failure._tag).toBe("PasswordHasher.PasswordHashError");
    }),
  );
});
