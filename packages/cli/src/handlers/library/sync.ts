import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { RegistryAuth } from "../../registry/auth-service.js";
import { Option, Effect, Result } from "effect";
import { Command, Flag } from "effect/cli";
import { handleSourceCommand } from "../../application.js";
import type { ResolvedAuth } from "../../registry/auth.js";
import { libraryCommandConfiguration } from "../../commands/library-configuration.js";
import { CommandMetadata, sourceAcquisitionSubprocesses } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags, optionalString, optionValue } from "../../commands/parameters.js";
import { syncLibraryEffect } from "../../workflows/library/library-sync.js";
import type { LibraryInstallationConfiguration } from "../../library/installation-configuration.js";
import { officialRegistryOrigin } from "../../registry/accounts.js";
import { Renderer } from "../../presentation/renderer.js";
import { createColors } from "picocolors";
import { result } from "../contracts.js";
import { terminalSyncProgress } from "../../presentation/sync-progress.js";
import { renderLibrarySyncPlan } from "../../presentation/library-sync.js";
import { terminalData } from "../../presentation/terminal-text.js";
import { OptionCombinationInvalid } from "../../workflows/failures.js";
import type { InventoryRootOptions } from "../../projection/roots.js";

export const librarySyncCommand = Effect.fn("CLI.librarySync")(function* <AuthError>(options: {
  readonly authState: Result.Result<ResolvedAuth, AuthError>;
  readonly apply: boolean;
  readonly adopt: boolean;
  readonly takeRemote?: readonly string[];
  readonly keepEnabled?: readonly string[];
  readonly projection: Pick<LibraryInstallationConfiguration, "rootFor">;
  readonly inventory?: InventoryRootOptions;
  readonly deviceSelection?:
    | "follow-account"
    | { readonly skills: readonly string[]; readonly collections: readonly string[] };
}) {
  const auth = yield* Effect.fromResult(options.authState);
  const renderer = yield* Renderer;
  const progress = terminalSyncProgress(renderer);
  return yield* Effect.scoped(
    syncLibraryEffect({
      // With no Registry configured, sync asks the hosted Registry, which then asks for a login.
      origin: auth.origin ?? officialRegistryOrigin,
      ...(auth.token === undefined ? {} : { token: auth.token }),
      apply: options.apply,
      adopt: options.adopt,
      ...(options.takeRemote === undefined ? {} : { takeRemote: options.takeRemote }),
      ...(options.keepEnabled === undefined ? {} : { keepEnabled: options.keepEnabled }),
      projection: options.projection,
      ...(options.inventory === undefined ? {} : { inventory: options.inventory }),
      ...(options.deviceSelection === undefined
        ? {}
        : { deviceSelection: options.deviceSelection }),
      observer: progress.sync,
      restoreObserver: progress.restore,
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
  Flag.withDescription("Apply the current Library reconciliation plan."),
  Flag.withDefault(false),
);
const adopt = Flag.Boolean("adopt").pipe(
  Flag.withDescription(
    "Explicitly adopt the current remote Library, setting aside ancestry from another Library.",
  ),
  Flag.withDefault(false),
);
const takeRemote = Flag.String("take-remote").pipe(
  Flag.withDescription(
    "Resolve a named Collection or Binding conflict from the current remote Library.",
  ),
  Flag.atLeast(0),
);
const registry = optionalString("registry", "Select the Registry to synchronize.");
const keepEnabled = Flag.String("keep-enabled").pipe(
  Flag.withDescription(
    "Resolve a destination collision by keeping this Skill ID enabled; retain the other Skills without enabling them.",
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
    adopt,
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
    handleSourceCommand(
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
        const registryAuth = yield* RegistryAuth;
        const { authState } = yield* registryAuth.resolve(optionValue(input.registry), "skit sync");
        const value = yield* librarySyncCommand({
          authState,
          apply: input.apply,
          adopt: input.adopt,
          takeRemote: input.takeRemote,
          keepEnabled: input.keepEnabled,
          projection: configuration.pull.installation,
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
        });
        yield* renderer.result(
          result(
            "librarySync",
            value,
            value.status === "conflicted" ||
              value.status === "adoption_required" ||
              value.status === "base_mismatch" ||
              value.status === "resolution_invalid" ||
              value.status === "enablement_incomplete"
              ? 12
              : undefined,
          ),
        );
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription("Synchronize private retained Library bytes with skit-server."),
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
      subprocesses: sourceAcquisitionSubprocesses,
    },
    outputSchemas: [outputContracts.librarySync],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
