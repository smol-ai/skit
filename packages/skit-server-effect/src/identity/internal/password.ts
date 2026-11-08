import { Effect, Schema } from "effect";
import { WebCrypto } from "effect/crypto";

const ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

export class PasswordHashError extends Schema.TaggedError<
  PasswordHashError,
  { readonly brand: unique symbol }
>()("PasswordHasher.PasswordHashError", { cause: Schema.Defect() }) {}

const derivePromise = async (crypto: Crypto, password: string, salt: Uint8Array) => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: Uint8Array.from(salt).buffer,
        iterations: ITERATIONS,
        hash: "SHA-256",
      },
      material,
      HASH_BYTES * 8,
    ),
  );
};

/** Promise-shaped password implementation required by Better Auth callbacks. */
export const passwordCallbacks = (crypto: Crypto) => ({
  hash: async (password: string) => {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const derived = await derivePromise(crypto, password, salt);
    const combined = new Uint8Array(SALT_BYTES + HASH_BYTES);
    combined.set(salt);
    combined.set(derived, SALT_BYTES);
    return btoa(String.fromCharCode(...combined));
  },
  verify: async ({ hash, password }: { readonly hash: string; readonly password: string }) => {
    let combined: Uint8Array;
    try {
      combined = Uint8Array.from(atob(hash), (value) => value.charCodeAt(0));
    } catch {
      return false;
    }
    if (combined.byteLength !== SALT_BYTES + HASH_BYTES) return false;
    const expected = combined.slice(SALT_BYTES);
    const actual = await derivePromise(crypto, password, combined.slice(0, SALT_BYTES));
    let difference = 0;
    for (let index = 0; index < HASH_BYTES; index++) difference |= expected[index] ^ actual[index];
    return difference === 0;
  },
});

/** Effect boundary for the same callbacks Better Auth uses. */
export const hashPassword = Effect.fn("Password.hash")(function* (password: string) {
  const crypto = yield* WebCrypto.WebCrypto;
  // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth's shared password implementation is Promise-shaped; this function owns its Effect boundary.
  return yield* Effect.tryPromise({
    try: () => passwordCallbacks(crypto).hash(password),
    catch: (cause) => new PasswordHashError({ cause }),
  });
});
