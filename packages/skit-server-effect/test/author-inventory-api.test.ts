import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { HttpApiTest } from "effect/unstable/httpapi";
import {
  CurrentPrincipal,
  CurrentRequest,
  PrincipalAuthentication,
} from "../src/api/authentication.js";
import { authorInventoryHandlers } from "../src/api/author-inventory-http.js";
import { AuthoringAuthenticatedApi } from "../src/api/authenticated.js";
import { requestDecodingLayer } from "../src/api/request-decoding.js";
import { AuthorInventory, type AuthorInventoryService } from "../src/author-inventory/service.js";
import type { Principal } from "../src/auth/authentication.js";

const principal = (scopes: Principal["scopes"]): Principal => ({
  id: "principal_test",
  credential: "session",
  scopes,
});

const middleware = (current: Principal) =>
  Layer.succeed(
    PrincipalAuthentication,
    PrincipalAuthentication.of((effect) =>
      effect.pipe(
        Effect.provideService(CurrentPrincipal, current),
        Effect.provideService(CurrentRequest, new Request("https://skit.test/api/author/skits")),
      ),
    ),
  );

const inventory = Layer.succeed(
  AuthorInventory,
  AuthorInventory.of({
    read: (_principal, query) =>
      Effect.succeed(
        query?.cursor === "invalid"
          ? { outcome: "invalid_cursor" as const }
          : {
              outcome: "page" as const,
              skits: [
                {
                  skit_id: "tim/tools",
                  visibility: "private" as const,
                  draft_revision_id: "revision_test",
                  most_recent_release_version: "1.2.3",
                },
              ],
              next_cursor: null,
            },
      ),
  } satisfies AuthorInventoryService),
);

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
            draft_revision_id: "revision_test",
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
