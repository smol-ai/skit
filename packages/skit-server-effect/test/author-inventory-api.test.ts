import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { CurrentPrincipal, PrincipalAuthentication } from "../src/api/authentication.js";
import { authorInventoryHandlers } from "../src/api/author-inventory-http.js";
import { AuthoringAuthenticatedApi } from "@smolai/skit-core/api";
import { requestDecodingLayer } from "../src/api/request-decoding.js";
import { Skits } from "../src/skits/service.js";
import type { Principal } from "../src/identity/service.js";
import * as History from "@smolai/skit-core/history";
import { Schema } from "effect";

const revisionId = Schema.decodeSync(History.RevisionId)(`sha256:${"a".repeat(64)}`);

const principal = (scopes: Principal["scopes"]): Principal => ({
  id: "principal_test",
  credential: "session",
  scopes,
});

const middleware = (current: Principal) =>
  Layer.succeed(
    PrincipalAuthentication,
    PrincipalAuthentication.of((effect) =>
      effect.pipe(Effect.provideService(CurrentPrincipal, current)),
    ),
  );

const unexpectedReleaseRead = () => Effect.die("Inventory HTTP must not read release archives");
const inventory = Layer.mock(Skits, {
  releases: {
    findLatestPublic: unexpectedReleaseRead,
    findDownload: unexpectedReleaseRead,
  },
  list: (_principal, query) =>
    Effect.succeed(
      query?.cursor === "invalid"
        ? { outcome: "invalid_cursor" as const }
        : {
            outcome: "page" as const,
            skits: [
              {
                skit_id: "tim/tools",
                visibility: "private" as const,
                current_revision_id: revisionId,
                current_revision_published: false,
                most_recent_release_version: "1.2.3",
              },
            ],
            next_cursor: null,
          },
    ),
});

const makeClient = HttpApiTest.groups(AuthoringAuthenticatedApi, ["authorInventory"]);
const handlers = (current: Principal) =>
  Layer.mergeAll(
    authorInventoryHandlers.pipe(Layer.provide(inventory)),
    HttpServer.layerServices,
  ).pipe(Layer.provideMerge(middleware(current)), Layer.provideMerge(requestDecodingLayer));

layer(handlers(principal(new Set(["authoring:write"]))))("AuthorInventoryApi", (it) => {
  it.effect("serves inventory and preserves the invalid cursor transport error", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;

      expect(yield* client.authorInventory.read({ query: { limit: "20" } })).toEqual({
        skits: [
          {
            skit_id: "tim/tools",
            visibility: "private",
            current_revision_id: revisionId,
            current_revision_published: false,
            most_recent_release_version: "1.2.3",
          },
        ],
        next_cursor: null,
      });

      expect(
        yield* Effect.flip(client.authorInventory.read({ query: { cursor: "invalid" } })),
      ).toEqual({ error: "invalid_cursor" });
    }),
  );
});

layer(handlers(principal(new Set())))("AuthorInventoryApi authorization", (it) => {
  it.effect("rejects a principal without authoring scope", () =>
    Effect.gen(function* () {
      const client = yield* makeClient;
      expect(yield* Effect.flip(client.authorInventory.read({ query: {} }))).toEqual({
        error: "insufficient_scope",
      });
    }),
  );
});
