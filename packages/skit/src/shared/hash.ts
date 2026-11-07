import { Schema, Effect } from "effect";
import { Digest } from "effect/crypto";
// Domain vocabulary shared by the Library store, the wire contracts, and Harness code.
export const Hash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u));
export type Hash = typeof Hash.Type;

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

/** SHA-256 through Effect's Digest service, so it runs unchanged on Node and the Worker. */
export const sha256Hash = Effect.fn("Hash.sha256")(function* (bytes: Uint8Array) {
  const hex = yield* (yield* Digest.Digest).digestHex(Digest.sha256, bytes);
  return `sha256:${hex}` as const satisfies Hash;
});

/** A hash's hex digits without the `sha256:` prefix, as stored objects are named. */
export const hashHex = (hash: Hash) => hash.slice("sha256:".length);
