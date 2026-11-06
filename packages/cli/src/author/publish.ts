import { Effect } from "effect";

import { MissingRequirement } from "../commands/input-failures.js";
import { publishAuthorWorkspace } from "@smolai/skit-core/author";
import { authorRegistry } from "../registry/author-sync.js";
import { Renderer } from "../terminal/renderer.js";

export const publish = Effect.fn("CLI.publishWorkspace")(function* (
  root: string,
  version: string,
  revision: string | undefined,
  options: { readonly home?: string } = {},
) {
  return yield* publishAuthorWorkspace(
    root,
    { version, revision },
    authorRegistry(options.home),
  );
});

export const publishCommand = Effect.fn("CLI.publish")(function* (options: {
  readonly root?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly home?: string;
}) {
  if (!options.version)
    return yield* new MissingRequirement({ command: "publish", requires: "--version" });

  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Packaging and publishing release",
    publish(options.root ?? ".", options.version, options.revision, { home: options.home }),
  );
});
