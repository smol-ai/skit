import { Effect, Result } from "effect";
import { listAuthorSkits } from "@smolai/skit-core/author";
import { type ResolvedAuth } from "../registry/index.js";
import { authorInventoryRegistry } from "../registry/authoring.js";
import { authorRegistry } from "../registry/author-sync.js";
import { Renderer } from "../terminal/renderer.js";

export interface AuthorListOptions<E> {
  readonly authState?: Result.Result<ResolvedAuth, E>;
  readonly registry?: string;
  readonly home?: string;
}

export const authorListCommand = Effect.fn("CLI.authorList")(function* <E = never>(
  options: AuthorListOptions<E>,
) {
  const registry =
    options.authState === undefined
      ? authorRegistry(options.home, options.registry)
      : authorInventoryRegistry(yield* Effect.fromResult(options.authState));
  const renderer = yield* Renderer;
  return yield* renderer.withStatus("Listing authored SKITs", listAuthorSkits(registry));
});
