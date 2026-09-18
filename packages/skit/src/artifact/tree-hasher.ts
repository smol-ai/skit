import { Context, Effect, Layer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { Digest } from "../contracts.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { TreeError } from "../shared/tree-error.js";
import { deterministicTreeHashEffect } from "./skit.js";

/**
 * The deterministic hash of a projected tree, reached through the environment.
 *
 * Projection verifies what it just wrote, so the only way to exercise a post-write hash
 * divergence and its rollback is to substitute this. Production supplies one implementation.
 */
export class TreeHasher extends Context.Service<
  TreeHasher,
  {
    readonly hash: (
      path: string,
    ) => Effect.Effect<Digest, TreeError | PlatformError, TreeRequirements>;
  }
>()("skit/artifact/TreeHasher") {}

export const treeHasherLayer: Layer.Layer<TreeHasher> = Layer.succeed(TreeHasher)({
  hash: deterministicTreeHashEffect,
});
