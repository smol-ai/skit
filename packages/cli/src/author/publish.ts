import { Effect } from "effect";

import { MissingRequirement } from "../commands/input-failures.js";
import { publish } from "./publish/workflow.js";
import { Renderer } from "../terminal/renderer.js";

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
