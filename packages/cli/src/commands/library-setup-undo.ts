import { Cause, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { commandFailure, handleLibraryCommand } from "./handler.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { CommandMetadata } from "./metadata.js";
import { setupOutputContracts, setupUndoActions, prepareSetupUndo } from "../library/setup.js";
import { homeFlag, jsonFlag, optionalString } from "./parameters.js";

import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

export const librarySetupUndoCliCommand = Command.make(
  "undo",
  {
    operation: Argument.String("operation"),
    home: homeFlag,
    json: jsonFlag,
    apply: optionalString(
      "apply",
      "Undo only the exact reviewed planId. Omit to preview without writing.",
    ),
  },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const configuration = yield* SkitConfiguration;
        const renderer = yield* Renderer;
        const prepared = yield* Effect.result(prepareSetupUndo(input.operation));
        if (prepared._tag === "Failure") {
          const failure = commandFailure(Cause.fail(prepared.failure));
          return yield* renderer.result(
            result(
              "setupUndo",
              setupOutputContracts.setupUndo,
              {
                operationId: input.operation,
                status: "conflicted",
                phase: "failed",
                conflicts: [],
                files: [],
                intentChanged: false,
                settingsChanged: false,
                sourceSelections: [],
                failure: failure.message,
                actions: setupUndoActions(configuration.skitHome, input.operation),
              },
              failure.exitCode,
            ),
          );
        }
        const plan = prepared.success;
        const approved = Option.getOrUndefined(input.apply);
        if (approved === undefined)
          return yield* renderer.result(
            result(
              "setupUndo",
              setupOutputContracts.setupUndo,
              {
                ...plan.summary,
                phase: "preview",
                actions: setupUndoActions(
                  configuration.skitHome,
                  input.operation,
                  plan.summary.status === "ready" ? plan.summary.planId : undefined,
                ),
              },
              plan.summary.status === "conflicted" ? 12 : 0,
            ),
          );
        if (approved !== plan.summary.planId)
          return yield* renderer.result(
            result(
              "setupUndo",
              setupOutputContracts.setupUndo,
              {
                ...plan.summary,
                phase: "stale",
                failure:
                  "Setup undo evidence changed. Review the refreshed preview before applying.",
                actions: setupUndoActions(configuration.skitHome, input.operation),
              },
              12,
            ),
          );
        const applied = yield* Effect.result(plan.apply());
        if (applied._tag === "Failure") {
          const failure = commandFailure(Cause.fail(applied.failure));
          return yield* renderer.result(
            result(
              "setupUndo",
              setupOutputContracts.setupUndo,
              {
                ...plan.summary,
                phase: "failed",
                failure: failure.message,
                actions: setupUndoActions(configuration.skitHome, input.operation),
              },
              failure.exitCode,
            ),
          );
        }
        const undone = applied.success;
        yield* renderer.result(
          result("setupUndo", setupOutputContracts.setupUndo, {
            ...undone,
            phase: "applied",
            actions: [
              ...setupUndoActions(configuration.skitHome, input.operation),
              ...("backupId" in undone
                ? [
                    {
                      rel: "inspect-preserved",
                      argv: [
                        "skit",
                        "library",
                        "recovery",
                        "inspect",
                        undone.backupId,
                        "--home",
                        configuration.skitHome,
                        "--json",
                      ],
                      effect: "read" as const,
                    },
                  ]
                : []),
            ],
          }),
        );
      }),
      Option.getOrUndefined(input.home),
    ),
).pipe(
  Command.withDescription(
    "Preview or undo one setup's intent, installed copies and machine discovery settings while keeping what was imported into the Library.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [setupOutputContracts.setupUndo],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
