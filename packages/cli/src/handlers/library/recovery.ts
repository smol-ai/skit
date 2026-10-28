import { Cause, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { LibraryStore } from "@smolai/skit-core";
import { handleLibraryCommand, commandFailure } from "../../application.js";
import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { recoveryActions } from "../../commands/recovery-contract.js";
import { homeFlag, jsonFlag, optionalString } from "../../commands/parameters.js";
import {
  inspectRecoveryOperation,
  listRecoveryOperations,
  prepareRecoveryRestore,
} from "../../library-application/recovery-moves.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

const flags = { home: homeFlag, json: jsonFlag };
const operation = Argument.String("operation");
const apply = optionalString(
  "apply",
  "Restore only if this reviewed recovery planId still matches. Omit to preview.",
);

const list = Command.make("list", flags, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const home = store.home;
      const operations = yield* listRecoveryOperations(home);
      const renderer = yield* Renderer;
      yield* renderer.result(
        result("recoveryList", {
          operations: operations.map((operationId) => ({
            operationId,
            actions: recoveryActions(home, operationId).filter(
              (action) => action.rel === "inspect",
            ),
          })),
        }),
      );
    }),
  ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "List machine-local saved-file recovery operations; files are kept until you remove them.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [outputContracts.recoveryList],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

const inspect = Command.make("inspect", { operation, ...flags }, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const home = store.home;
      const inspection = yield* inspectRecoveryOperation(home, input.operation);
      const renderer = yield* Renderer;
      yield* renderer.result(
        result("recovery", {
          ...inspection,
          phase: "inspection",
          actions: recoveryActions(home, input.operation),
        }),
      );
    }),
  ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Inspect the move records and the original and saved files without changing them.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [outputContracts.recovery],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);

const restore = Command.make("restore", { operation, apply, ...flags }, (input) =>
  handleLibraryCommand(
    Effect.gen(function* () {
      const store = yield* LibraryStore;
      const home = store.home;
      const renderer = yield* Renderer;
      const plan = yield* prepareRecoveryRestore(home, input.operation);
      const approved = Option.getOrUndefined(input.apply);
      if (approved === undefined)
        return yield* renderer.result(
          result("recovery", {
            ...plan.summary,
            phase: "preview",
            actions: recoveryActions(
              home,
              input.operation,
              plan.summary.entries.some((entry) => entry.status === "saved")
                ? plan.summary.planId
                : undefined,
            ),
          }),
        );
      if (approved !== plan.summary.planId)
        return yield* renderer.result(
          result(
            "recovery",
            {
              ...plan.summary,
              phase: "stale",
              failure: "The recovery plan changed. Review a new preview before applying.",
              actions: recoveryActions(home, input.operation),
            },
            12,
          ),
        );
      const applied = yield* Effect.result(plan.apply());
      const inspection =
        applied._tag === "Success"
          ? applied.success
          : yield* inspectRecoveryOperation(home, input.operation);
      const failed =
        applied._tag === "Failure" ? commandFailure(Cause.fail(applied.failure)) : undefined;
      const allRestored = inspection.entries.every((entry) => entry.status === "at-original");
      const someRestored = inspection.entries.some((entry) => entry.status === "at-original");
      yield* renderer.result(
        result(
          "recovery",
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
  ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Preview or restore verified saved files into free original paths. Does not change what is enabled or any settings.",
  ),
  Command.withExamples([{ command: "skit library recovery restore OPERATION --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [outputContracts.recovery],
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
