import { generateInvocationMetadata } from "@smolai/skit-core/author";
import { Effect } from "effect";
import { resolve } from "node:path";

import { AuthorWorkspace } from "@smolai/skit-core/author";

export const authorInvocationCommand = Effect.fn("CLI.authorInvocation")(function* (
  input: string,
  dryRun: boolean,
) {
  const root = resolve(input);
  if (dryRun)
    return { root, dryRun, generated: yield* generateInvocationMetadata(root, { dryRun }) };
  // A built-in edit runs under the workspace lease, so it can never race a sync (A11).
  const workspaces = yield* AuthorWorkspace;
  yield* workspaces.acquire(yield* workspaces.resolveRoot(root));
  const generated = yield* generateInvocationMetadata(root, { dryRun });
  return { root, dryRun, generated };
}, Effect.scoped);
