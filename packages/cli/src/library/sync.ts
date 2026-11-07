import { type ResolvedAuth } from "../registry/index.js";
import { Effect, Result } from "effect";

import * as Library from "@smolai/skit-core/library";
import { librarySyncApi } from "./sync/api.js";
import { officialRegistryOrigin } from "../registry/accounts.js";
import { Renderer } from "../terminal/renderer.js";
import { createColors } from "picocolors";
import { terminalSyncProgress } from "./sync/present-progress.js";
import { renderLibrarySyncPlan } from "./sync/present.js";
import { terminalData } from "../terminal/text.js";

export const librarySyncCommand = Effect.fn("CLI.librarySync")(function* <AuthError>(options: {
  readonly authState: Result.Result<ResolvedAuth, AuthError>;
  readonly apply: boolean;
  readonly takeRemote?: readonly string[];
  readonly keepEnabled?: readonly string[];
  readonly deviceSelection?:
    | "follow-account"
    | {
        readonly skills: readonly string[];
        readonly collections: readonly string[];
      };
}) {
  const auth = yield* Effect.fromResult(options.authState);
  const renderer = yield* Renderer;
  const progress = terminalSyncProgress(renderer);
  // With no Registry configured, sync asks the hosted Registry, which then asks for a login.
  const origin = auth.origin ?? officialRegistryOrigin;
  const library = yield* Library.Service;
  return yield* Effect.scoped(
    Effect.flatMap(
      librarySyncApi({
        origin,
        ...(auth.token === undefined ? {} : { token: auth.token }),
      }),
      (transport) =>
        library.sync(
          {
            origin,
            ...(auth.token === undefined ? {} : { token: auth.token }),
            apply: options.apply,
            ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
            ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
            ...(options.deviceSelection === undefined
              ? {}
              : { deviceSelection: options.deviceSelection }),
            progress: progress.sync,
            restoreProgress: progress.restore,
            ...(options.apply
              ? {
                  onPlan: (plan) =>
                    renderer.note(renderLibrarySyncPlan(plan), "Applying Library sync plan", {
                      renderBody: (color) =>
                        renderLibrarySyncPlan(terminalData(plan), createColors(color)),
                    }),
                }
              : {}),
          },
          transport,
        ),
    ),
  );
});

export { syncOutputContracts } from "./sync/output.js";

export { renderLibrarySync } from "./sync/present.js";
