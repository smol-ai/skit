import { Context, Effect, Layer, Schema } from "effect";
import { NativeCrypto } from "../platform/native-crypto.js";

const ITERATIONS = 100_000;
const HASH_BYTES = 32;
const SALT_BYTES = 16;

export class PasswordHashError extends Schema.TaggedError<PasswordHashError>()(
  "PasswordHasher.PasswordHashError",
  { cause: Schema.Defect() },
) {}

export interface PasswordHasherService {
  readonly hash: (password: string) => Effect.Effect<string, PasswordHashError>;
  readonly verify: (password: string, stored: string) => Effect.Effect<boolean, PasswordHashError>;
}

export class PasswordHasher extends Context.Service<PasswordHasher, PasswordHasherService>()(
  "@skit-server-effect/PasswordHasher",
) {}

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

export const layer = Layer.effect(
  PasswordHasher,
  Effect.gen(function* () {
    const crypto = yield* NativeCrypto;
    const callbacks = passwordCallbacks(crypto);
    const hash = Effect.fn("PasswordHasher.hash")((password: string) =>
      // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth's password implementation is Promise-shaped; PasswordHasher owns the Effect adapter.
      Effect.tryPromise({
        try: () => callbacks.hash(password),
        catch: (cause) => new PasswordHashError({ cause }),
      }),
    );

    const verify = Effect.fn("PasswordHasher.verify")((password: string, stored: string) =>
      // oxlint-disable-next-line skit/no-promise-wrappers -- Better Auth's password implementation is Promise-shaped; PasswordHasher owns the Effect adapter.
      Effect.tryPromise({
        try: () => callbacks.verify({ hash: stored, password }),
        catch: (cause) => new PasswordHashError({ cause }),
      }),
    );

    return PasswordHasher.of({ hash, verify });
  }),
);
