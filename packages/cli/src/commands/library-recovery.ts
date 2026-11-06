import { Cause, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { handleLibraryCommand, commandFailure } from "./handler.js";
import { CommandMetadata } from "./metadata.js";
import { recoveryOutputContracts, recoveryActions } from "../library/recovery.js";

import { homeFlag, jsonFlag, optionalString } from "./parameters.js";
import {
  inspectLibraryRecovery,
  listLibraryRecovery,
  openRecoveryRestore,
} from "@smolai/skit-core/library/session";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

const flags = { home: homeFlag, json: jsonFlag };

const operation = Argument.String("operation");

const apply = optionalString(
  "apply",
  "Restore only if this reviewed recovery planId still matches. Omit to preview.",
);

const list = Command.make("list", flags, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
      const operations = yield* listLibraryRecovery();
      const renderer = yield* Renderer;
      yield* renderer.result(
        result("recoveryList", recoveryOutputContracts.recoveryList, {
          operations: operations.map((operationId) => ({
            operationId,
            actions: recoveryActions(home, operationId).filter(
              (action) => action.rel === "inspect",
            ),
          })),
        }),
      );
    }),
    Option.getOrUndefined(input.home),
  ),
).pipe(
  Command.withDescription(
    "List machine-local saved-file recovery operations; files are kept until you remove them.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [recoveryOutputContracts.recoveryList],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

const inspect = Command.make("inspect", { operation, ...flags }, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
      const inspection = yield* inspectLibraryRecovery(input.operation);
      const renderer = yield* Renderer;
      yield* renderer.result(
        result("recovery", recoveryOutputContracts.recovery, {
          ...inspection,
          phase: "inspection",
          actions: recoveryActions(home, input.operation),
        }),
      );
    }),
    Option.getOrUndefined(input.home),
  ),
).pipe(
  Command.withDescription(
    "Inspect the move records and the original and saved files without changing them.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [recoveryOutputContracts.recovery],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

const restore = Command.make("restore", { operation, apply, ...flags }, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
      const renderer = yield* Renderer;
      const restore = yield* openRecoveryRestore(input.operation);
      const plan = { change: restore.change };
      const approved = Option.getOrUndefined(input.apply);
      if (approved === undefined)
        return yield* renderer.result(
          result("recovery", recoveryOutputContracts.recovery, {
            ...plan.change,
            phase: "preview",
            actions: recoveryActions(
              home,
              input.operation,
              plan.change.entries.some((entry) => entry.status === "saved")
                ? plan.change.planId
                : undefined,
            ),
          }),
        );
      if (approved !== plan.change.planId)
        return yield* renderer.result(
          result(
            "recovery",
            recoveryOutputContracts.recovery,
            {
              ...plan.change,
              phase: "stale",
              failure: "The recovery plan changed. Review a new preview before applying.",
              actions: recoveryActions(home, input.operation),
            },
            12,
          ),
        );
      const applied = yield* restore.apply;
      const inspection = applied.inspection;
      const failed =
        applied._tag === "Failed" ? commandFailure(Cause.fail(applied.failure)) : undefined;
      const allRestored = inspection.entries.every((entry) => entry.status === "at-original");
      const someRestored = inspection.entries.some((entry) => entry.status === "at-original");
      yield* renderer.result(
        result(
          "recovery",
          recoveryOutputContracts.recovery,
          {
            ...inspection,
            phase: failed
              ? "failed"
              : allRestored
                ? "restored"
                : someRestored
                  ? "partial"
                  : "conflicted",
            ...(failed ? { failure: failed.message } : {}),
            actions: recoveryActions(home, input.operation),
          },
          failed?.exitCode ?? (allRestored ? 0 : 12),
        ),
      );
    }),
    Option.getOrUndefined(input.home),
  ),
).pipe(
  Command.withDescription(
    "Preview or restore verified saved files into free original paths. Does not change what is enabled or any settings.",
  ),
  Command.withExamples([{ command: "skit library recovery restore OPERATION --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [recoveryOutputContracts.recovery],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

export const libraryRecoveryCliCommand = Command.make("recovery").pipe(
  Command.withDescription(
    "Inspect and restore saved files. This is filesystem recovery, not setup undo.",
  ),
  Command.withSubcommands([list, inspect, restore]),
);
