import { D1Client } from "@effect/sql-d1";
import { Clock, Context, Effect, Layer } from "effect";
import { Digest, SecureRandom } from "effect/crypto";
import { Authorization } from "../authorization/service.js";
import { BlobStore } from "../platform/cloudflare.js";
import { findOwnedLibrary, type FindLibrary } from "./internal/owned.js";
import { makeSync, type Sync } from "./internal/sync.js";
import { makeSnapshots, type Snapshots } from "./internal/snapshots.js";

export interface ServerLibraryService extends Sync {
  readonly snapshots: Snapshots;
}

/** Owns default Libraries, their revision heads and immutable snapshot availability. */
export class ServerLibrary extends Context.Service<ServerLibrary, ServerLibraryService>()(
  "@skit-server-effect/ServerLibrary",
) {}

export const layer = Layer.effect(
  ServerLibrary,
  Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const blobs = yield* BlobStore;
    const authorization = yield* Authorization;
    const digests = yield* Digest.Digest;
    const clock = yield* Clock.Clock;
    const random = yield* SecureRandom.SecureRandom;
    const own: FindLibrary = (principal, create) =>
      findOwnedLibrary({ sql, principal, create, clock, randomUUID: random.uuidV4 });
    return ServerLibrary.of({
      ...makeSync(sql, random, own),
      snapshots: makeSnapshots(sql, blobs, authorization, digests, clock, own),
    });
  }),
);
