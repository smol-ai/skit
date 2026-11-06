import { type ResolvedAuth } from "../registry/index.js";
import { Effect, Result } from "effect";

import { syncLibrary } from "@smolai/skit-core/library/sync";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { librarySyncApi } from "./sync/api.js";
import type { LibraryInstallationConfiguration } from "./installation-configuration.js";
import { officialRegistryOrigin } from "../registry/accounts.js";
import { Renderer } from "../terminal/renderer.js";
import { createColors } from "picocolors";
import { terminalSyncProgress } from "./sync/present-progress.js";
import { renderLibrarySyncPlan } from "./sync/present.js";
import { terminalData } from "../terminal/text.js";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";

export const librarySyncCommand = Effect.fn("CLI.librarySync")(function* <AuthError>(options: {
  readonly authState: Result.Result<ResolvedAuth, AuthError>;
  readonly apply: boolean;
  readonly takeRemote?: readonly string[];
  readonly keepEnabled?: readonly string[];
  readonly installedSkill: Pick<LibraryInstallationConfiguration, "rootFor">;
  readonly inventory?: InventoryRootOptions;
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
  const home = (yield* SkitConfiguration).skitHome;
  return yield* Effect.scoped(
    Effect.flatMap(
      librarySyncApi({
        origin,
        ...(auth.token === undefined ? {} : { token: auth.token }),
      }),
      (transport) =>
        syncLibrary(
          home,
          {
            origin,
            ...(auth.token === undefined ? {} : { token: auth.token }),
            apply: options.apply,
            ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
            ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
            installedSkill: options.installedSkill,
            ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
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
