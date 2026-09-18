import { Context, Layer } from "effect";

export class NativeCrypto extends Context.Service<NativeCrypto, Crypto>()(
  "@skit-server-effect/NativeCrypto",
) {}

export const layer = Layer.succeed(NativeCrypto, globalThis.crypto);
