import { Effect } from "effect";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import {
  syncAuthorWorkspace as syncWorkspace,
  type AuthorVisibility,
} from "@smolai/skit-core/author";
import { authorRegistry } from "../../registry/author-sync.js";

export const syncAuthorWorkspace = Effect.fn("CLI.syncAuthorWorkspace")(function* (
  root: string,
  options: {
    readonly apply: boolean;
    readonly allowLargeDeletion?: boolean;
    readonly home?: string;
    readonly to?: string;
    readonly visibility?: AuthorVisibility;
  },
) {
  const home = options.home ?? (yield* SkitConfiguration).skitHome;
  return yield* syncWorkspace(root, { ...options, home }, authorRegistry(home));
});
