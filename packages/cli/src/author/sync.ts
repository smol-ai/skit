import { Effect } from "effect";
import type { AuthorVisibility } from "@smolai/skit-core/author";

import { Renderer } from "../terminal/renderer.js";
import { syncAuthorWorkspace } from "./sync/workflow.js";

export const authorSyncCommand = Effect.fn("CLI.authorSync")(function* (options: {
  readonly root?: string;
  readonly apply: boolean;
  readonly allowLargeDeletion?: boolean;
  readonly home?: string;
  readonly to?: string;
  readonly visibility?: AuthorVisibility;
}) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Synchronizing skit",
    Effect.scoped(
      syncAuthorWorkspace(options.root ?? ".", {
        apply: options.apply,
        allowLargeDeletion: options.allowLargeDeletion,
        home: options.home,
        to: options.to,
        visibility: options.visibility,
      }),
    ),
  );
});
