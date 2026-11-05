import { Cause, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { SkitConfiguration } from "@smolai/skit-core";
import { handleLibraryCommand, commandFailure } from "../../application.js";
import { skitConfigurationLayer } from "@smolai/skit-core";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { recoveryActions } from "../../commands/recovery-contract.js";
import { homeFlag, jsonFlag, optionalString } from "../../commands/parameters.js";
import { inspectRecoveryOperation, listRecoveryOperations } from "@smolai/skit-core";
import { Library } from "@smolai/skit-core/library";
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
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
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
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
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
      const configuration = yield* SkitConfiguration;
      const home = configuration.skitHome;
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      const plan = yield* library.plan(
        { _tag: "Restore", operationId: input.operation },
        { base: yield* library.read },
      );
      const approved = Option.getOrUndefined(input.apply);
      if (approved === undefined)
        return yield* renderer.result(
          result("recovery", {
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
            {
              ...plan.change,
              phase: "stale",
              failure: "The recovery plan changed. Review a new preview before applying.",
              actions: recoveryActions(home, input.operation),
            },
            12,
          ),
        );
      const applied = yield* Effect.result(library.apply({ _tag: "Apply", plan: plan }));
      const inspection =
        applied._tag === "Success"
          ? applied.success.result.after
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
