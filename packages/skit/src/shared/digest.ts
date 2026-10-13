import { Crypto, Effect } from "effect";
import type { Digest } from "../vocabulary.js";

/**
 * Length-framed digest input: each part is `<byte length>:<bytes>\0`, so `["ab", "c"]` and
 * `["a", "bc"]` never hash alike. The CLI and the Registry Worker hash these same bytes, so a
 * Skill's content hash agrees wherever it is computed.
 */
export function encodeHashParts(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.flatMap((part) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    return [encoder.encode(`${bytes.byteLength}:`), bytes, Uint8Array.of(0)];
  });
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** SHA-256 through Effect's Crypto service, so it runs unchanged on Node and the Worker. */
export const sha256Digest = Effect.fn("Digest.sha256")(function* (bytes: Uint8Array) {
  const digest = yield* (yield* Crypto.Crypto).digest("SHA-256", bytes);
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const satisfies Digest;
});
