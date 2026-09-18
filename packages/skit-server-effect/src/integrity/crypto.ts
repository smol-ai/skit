import { Crypto, Effect } from "effect";
import type { Digest } from "./contracts.js";

export const sha256 = Effect.fn("Integrity.sha256")(function* (value: Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", value);
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` satisfies Digest;
});

export const encodeHashParts = (parts: ReadonlyArray<string | Uint8Array>): Uint8Array => {
  const encoder = new TextEncoder();
  const encoded = parts.flatMap((part) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    return [encoder.encode(`${bytes.byteLength}:`), bytes, Uint8Array.of(0)];
  });
  const length = encoded.reduce((total, bytes) => total + bytes.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const bytes of encoded) {
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return result;
};
