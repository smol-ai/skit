import { Effect } from "effect";
import { parseAuthorDestination } from "./destination.js";
import type { AuthorRegistry } from "./transport.js";

export const deleteAuthorSkit = Effect.fn("Author.delete")(function* <
  E,
  R,
  DeleteError,
  DeleteRequirements,
>(
  destination: string,
  options: { readonly dryRun?: boolean },
  registry: Pick<AuthorRegistry<E, R>, "origin"> &
    Pick<AuthorRegistry<DeleteError, DeleteRequirements>, "delete">,
) {
  const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(destination);
  const remote = yield* parseAuthorDestination(
    destination,
    concrete ? undefined : yield* registry.origin,
  );
  return yield* registry.delete(remote, options);
});
