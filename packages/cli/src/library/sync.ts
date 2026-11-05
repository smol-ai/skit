import { syncLibraryApplicationLayer } from "./sync/layer.js";
import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Registry, type ResolvedAuth } from "../registry/index.js";
import { Option, Effect, Result } from "effect";
import { Command, Flag } from "effect/cli";
import { handleRegistryCommand } from "../commands/handler.js";

import { libraryCommandConfiguration } from "../commands/library-configuration.js";
import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "../commands/metadata.js";
import { syncOutputContracts } from "./sync/output.js";
import { localFlags, optionalString, optionValue } from "../commands/parameters.js";
import { syncLibrary } from "./sync/workflow.js";
import type { LibraryInstallationConfiguration } from "./installation-configuration.js";
import { officialRegistryOrigin } from "../registry/accounts.js";
import { Renderer } from "../terminal/renderer.js";
import { createColors } from "picocolors";
import { encodeResult as result } from "../commands/encode-result.js";
import { terminalSyncProgress } from "./sync/present-progress.js";
import { renderLibrarySyncPlan } from "./sync/present.js";
import { terminalData } from "../terminal/text.js";
import { OptionCombinationInvalid } from "../commands/input-failures.js";
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
    | { readonly skills: readonly string[]; readonly collections: readonly string[] };
}) {
  const auth = yield* Effect.fromResult(options.authState);
  const renderer = yield* Renderer;
  const progress = terminalSyncProgress(renderer);
  return yield* Effect.scoped(
    syncLibrary({
      // With no Registry configured, sync asks the hosted Registry, which then asks for a login.
      origin: auth.origin ?? officialRegistryOrigin,
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
    }),
  );
});

const apply = Flag.Boolean("apply").pipe(
  Flag.withDescription("Apply the current sync plan."),
  Flag.withDefault(false),
);
const takeRemote = Flag.String("take-remote").pipe(
  Flag.withDescription("Resolve a named content conflict from the current remote Library."),
  Flag.atLeast(0),
);
const registry = optionalString("registry", "Select the Registry to synchronize.");
const keepEnabled = Flag.String("keep-enabled").pipe(
  Flag.withDescription(
    "Resolve a destination collision by keeping this Skill ID enabled; keep the other Skills in the Library without enabling them.",
  ),
  Flag.atLeast(0),
);
const deviceSkill = Flag.String("device-skill").pipe(
  Flag.withDescription("Choose an individual Skill for this device (repeatable)."),
  Flag.atLeast(0),
);
const deviceCollection = Flag.String("device-collection").pipe(
  Flag.withDescription("Choose a whole Collection for this device (repeatable)."),
  Flag.atLeast(0),
);
const deviceOnly = Flag.Boolean("device-only").pipe(
  Flag.withDescription("Replace this device's selection, allowing an empty selection."),
  Flag.withDefault(false),
);
const followAccount = Flag.Boolean("follow-account").pipe(
  Flag.withDescription("Follow the account's enabled selections on this device."),
  Flag.withDefault(false),
);

export const librarySyncCliCommand = Command.make(
  "sync",
  {
    apply,
    takeRemote,
    keepEnabled,
    registry,
    deviceSkill,
    deviceCollection,
    deviceOnly,
    followAccount,
    ...localFlags,
  },
  (input) =>
    handleRegistryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const choosing =
          input.deviceOnly || input.deviceSkill.length > 0 || input.deviceCollection.length > 0;
        if (input.followAccount && choosing)
          return yield* new OptionCombinationInvalid({
            detail: "Choose either --follow-account or a device selection.",
          });
        if ((input.followAccount || choosing) && !input.apply)
          return yield* new OptionCombinationInvalid({
            detail: "Changing device selection requires --apply.",
          });
        const configuration = yield* libraryCommandConfiguration(input);
        const authState = yield* Registry.credentials({
          registry: optionValue(input.registry),
          command: "skit sync",
        }).pipe(Effect.result);
        const value = yield* librarySyncCommand({
          authState,
          apply: input.apply,
          takeRemote: input.takeRemote,
          keepEnabled: input.keepEnabled,
          installedSkill: configuration.pull.installation,
          inventory: configuration.inventory,
          ...(input.followAccount
            ? { deviceSelection: "follow-account" as const }
            : choosing
              ? {
                  deviceSelection: {
                    skills: input.deviceSkill,
                    collections: input.deviceCollection,
                  },
                }
              : {}),
        }).pipe(Effect.provide(syncLibraryApplicationLayer(configuration.inventory)));
        yield* renderer.result(
          result(
            "librarySync",
            syncOutputContracts.librarySync,
            value,
            value.status === "conflicted" ||
              value.status === "resolution_invalid" ||
              value.status === "enablement_incomplete"
              ? 12
              : undefined,
          ),
        );
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Sync your Library with skit-server."),
  Command.withExamples([{ command: "skit sync" }, { command: "skit sync --apply" }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: [
        "filesystem.read",
        "filesystem.write",
        "network.read",
        "network.write",
        "process.execute",
      ],
      subprocesses: [...sourceFetchSubprocesses, ...credentialStoreReadSubprocesses],
    },
    outputSchemas: [syncOutputContracts.librarySync],
    exitCodes: [0, 11, 12, 13, 64, 65],
    interactive: false,
  }),
);

export { syncOutputContracts } from "./sync/output.js";
export { renderLibrarySync } from "./sync/present.js";
