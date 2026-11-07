import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Skits } from "../skits/service.js";
import { requirePrincipalScope } from "./authentication.js";
import { AuthoringAuthenticatedApi } from "@smolai/skit-core/api";
import { invalidCursorResponse, storageFailureResponse } from "./errors.js";
import { noStore } from "./response.js";

export const authorInventoryHandlers = HttpApiBuilder.group(
  AuthoringAuthenticatedApi,
  "authorInventory",
  (handlers) =>
    Effect.gen(function* () {
      const skits = yield* Skits;
      return handlers.handle("read", ({ query }) =>
        Effect.gen(function* () {
          const principal = yield* requirePrincipalScope("authoring:write");
          const page = yield* skits
            .list(principal, {
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
