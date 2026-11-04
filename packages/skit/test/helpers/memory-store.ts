import { NodeCrypto } from "@effect/platform-node";
import { Array, Effect, Option, Order } from "effect";
import { History } from "../../src/index.js";
import type { Hash } from "../../src/vocabulary.js";

/** A History.Store held in memory. It verifies like a durable store. */
export const memoryStore = Effect.suspend(() => {
  const documents = { tree: new Map<Hash, string>(), revision: new Map<Hash, string>() };
  return History.makeStore({
    read: (kind, hash) => Effect.sync(() => Option.fromUndefinedOr(documents[kind].get(hash))),
    write: (kind, hash, text) =>
      Effect.sync(() => {
        if (!documents[kind].has(hash)) documents[kind].set(hash, text);
      }),
    has: (kind, hash) => Effect.sync(() => documents[kind].has(hash)),
    list: (kind) => Effect.sync(() => Array.sort(documents[kind].keys(), Order.String)),
  });
}).pipe(Effect.provide(NodeCrypto.layerDigest));
