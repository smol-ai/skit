import { Effect } from "effect";
import { AuthorListIdentityError } from "./failures.js";
import { skitLocator } from "./destination.js";
import type { AuthorRegistry } from "./transport.js";

export const listAuthorSkits = Effect.fn("Author.list")(function* <E, R>(
  registry: Pick<AuthorRegistry<E, R>, "list">,
) {
  const { origin, skits } = yield* registry.list;
  const inventory = yield* Effect.forEach(skits, (skit) =>
    Effect.gen(function* () {
      const separator = skit.skit_id.indexOf("/");
      if (separator < 1 || separator === skit.skit_id.length - 1)
        return yield* new AuthorListIdentityError({ identity: skit.skit_id });
      return {
        identity: skitLocator({
          schema: "skit.remote.v1",
          origin,
          namespace: skit.skit_id.slice(0, separator),
          skit: skit.skit_id.slice(separator + 1),
        }),
        visibility: skit.visibility,
        current_revision_id: skit.current_revision_id,
        current_revision_published: skit.current_revision_published,
        most_recent_release_version: skit.most_recent_release_version,
      };
    }),
  );
  return { registry: origin, skits: inventory };
});

export { AuthorListIdentityError } from "./failures.js";
