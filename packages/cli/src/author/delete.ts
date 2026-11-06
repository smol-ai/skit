import { Effect, Result } from "effect";

import { parseAuthorDestination } from "./destination.js";
import { Registry, type ResolvedAuth } from "../registry/index.js";
import { deletePrivateAuthorSkit } from "../registry/authoring.js";
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
  const concrete = /^(?:skit:\/\/|https?:\/\/)/.test(destination);
  const startup = concrete ? undefined : yield* Effect.fromResult(options.authState);
  const remote = yield* parseAuthorDestination(destination, startup?.origin);
  const credentials = yield* Registry.credentials({ origin: remote.origin, home: options.home });
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    options.dryRun ? "Planning private SKIT deletion" : "Deleting private SKIT",
    Effect.scoped(
      deletePrivateAuthorSkit(remote, { token: credentials.token, dryRun: options.dryRun }),
    ),
  );
});
