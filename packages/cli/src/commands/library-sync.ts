import { defineCommand } from "./definition.js";
import { syncOutputContracts, librarySyncCommand } from "../library/sync.js";
import { Registry } from "../registry/index.js";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "./metadata.js";

import { localFlags, optionalString } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";
import { OptionCombinationInvalid } from "./input-failures.js";

const applySelectionRule = "Changing device selection requires --apply.";

const selectionRule = "Choose either --follow-account or a device selection.";

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

export const librarySyncCliCommand = defineCommand(
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
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const choosing =
        input.deviceOnly || input.deviceSkill.length > 0 || input.deviceCollection.length > 0;
      const selectionOptions = [
        ...(input.deviceOnly ? ["--device-only"] : []),
        ...(input.deviceSkill.length ? ["--device-skill"] : []),
        ...(input.deviceCollection.length ? ["--device-collection"] : []),
      ];
      if (input.followAccount && choosing)
        return yield* new OptionCombinationInvalid({
          reason: { _tag: "OptionConflicts", option: "--follow-account", others: selectionOptions },
        });
      if ((input.followAccount || choosing) && !input.apply)
        return yield* new OptionCombinationInvalid({
          reason: {
            _tag: "RequiresOption",
            options: [...(input.followAccount ? ["--follow-account"] : []), ...selectionOptions],
            required: "--apply",
          },
        });
      const authState = yield* Registry.librarySyncAccount(input.registry).pipe(Effect.result);
      const value = yield* librarySyncCommand({
        authState,
        apply: input.apply,
        takeRemote: input.takeRemote,
        keepEnabled: input.keepEnabled,
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
      yield* renderer.result(result("librarySync", syncOutputContracts.librarySync, value));
    }),
).pipe(
  Command.withDescription("Sync your Library with skit-server."),
  Command.withExamples([{ command: "skit sync" }, { command: "skit sync --apply" }]),
  Command.annotate(CommandMetadata, {
    handlerRules: [selectionRule, applySelectionRule],
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
    interactive: false,
  }),
);
