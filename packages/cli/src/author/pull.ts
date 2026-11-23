import { Effect } from "effect";
import { pullAuthorSkit } from "@smolai/skit-core/author";

import { authorRegistry } from "../registry/author-sync.js";
import { Renderer } from "../terminal/renderer.js";

export const authorPullCommand = Effect.fn("CLI.authorPull")(function* (
  source: string,
  options: { readonly directory?: string; readonly home: string },
) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Pulling skit",
    pullAuthorSkit(source, options, authorRegistry(options.home)),
  );
});
