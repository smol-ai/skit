import { Effect, Result } from "effect";

import { deleteAuthorSkit } from "@smolai/skit-core/author";
import { type ResolvedAuth } from "../registry/index.js";
import { authorRegistry } from "../registry/author-sync.js";
import { Renderer } from "../terminal/renderer.js";

export interface AuthorDeleteOptions<E> {
  readonly authState: Result.Result<ResolvedAuth, E>;
  readonly home?: string;
  readonly dryRun?: boolean;
}

/** Resolve one startup snapshot, destination and credential before issuing one scoped DELETE. */
export const authorDeleteCommand = Effect.fn("CLI.authorDelete")(function* <E>(
  destination: string,
  options: AuthorDeleteOptions<E>,
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    options.dryRun ? "Planning private SKIT deletion" : "Deleting private SKIT",
    Effect.scoped(
      deleteAuthorSkit(
        destination,
        { dryRun: options.dryRun },
        {
          ...authorRegistry(options.home),
          origin: Effect.fromResult(options.authState).pipe(Effect.map((auth) => auth.origin)),
        },
      ),
    ),
  );
});
