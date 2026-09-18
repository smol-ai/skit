import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AuthorInventory } from "../author-inventory/service.js";
import { CurrentPrincipal } from "./authentication.js";
import { AuthoringAuthenticatedApi } from "./authenticated.js";
import {
  insufficientScopeResponse,
  invalidCursorResponse,
  storageFailureResponse,
} from "./errors.js";
import { noStore } from "./response.js";

export const authorInventoryHandlers = HttpApiBuilder.group(
  AuthoringAuthenticatedApi,
  "authorInventory",
  (handlers) =>
    Effect.gen(function* () {
      const inventory = yield* AuthorInventory;
      return handlers.handle("read", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* CurrentPrincipal;
          if (!principal.scopes.has("authoring:write"))
            return yield* Effect.fail(insufficientScopeResponse);
          const page = yield* inventory
            .read(principal, {
              limit: query.limit,
              cursor: query.cursor,
            })
            .pipe(
              Effect.tapError((error) => Effect.logError("author inventory storage failed", error)),
              Effect.catchTag("Cloudflare.DatabaseError", () =>
                Effect.fail(storageFailureResponse),
              ),
            );
          if (page.outcome === "invalid_cursor") return yield* Effect.fail(invalidCursorResponse);

          yield* noStore;
          return { skits: page.skits, next_cursor: page.next_cursor };
        }),
      );
    }),
);
