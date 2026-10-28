import { Cause, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { LibraryStore } from "@smolai/skit-core";
import { commandFailure, handleLibraryCommand } from "../../application.js";
import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString } from "../../commands/parameters.js";
import { setupUndoActions } from "../../commands/setup-undo-contract.js";
import { prepareSetupUndo } from "../../library-application/setup-undo.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

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
        const store = yield* LibraryStore;
        const renderer = yield* Renderer;
        const prepared = yield* Effect.result(prepareSetupUndo(input.operation));
        if (prepared._tag === "Failure") {
          const failure = commandFailure(Cause.fail(prepared.failure));
          return yield* renderer.result(
            result(
              "setupUndo",
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
                actions: setupUndoActions(store.home, input.operation),
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
              {
                ...plan.summary,
                phase: "preview",
                actions: setupUndoActions(
                  store.home,
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
              {
                ...plan.summary,
                phase: "stale",
                failure:
                  "Setup undo evidence changed. Review the refreshed preview before applying.",
                actions: setupUndoActions(store.home, input.operation),
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
              {
                ...plan.summary,
                phase: "failed",
                failure: failure.message,
                actions: setupUndoActions(store.home, input.operation),
              },
              failure.exitCode,
            ),
          );
        }
        const undone = applied.success;
        yield* renderer.result(
          result("setupUndo", {
            ...undone,
            phase: "applied",
            actions: [
              ...setupUndoActions(store.home, input.operation),
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
                        store.home,
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
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
).pipe(
  Command.withDescription(
    "Preview or undo one setup's intent, installed copies and machine discovery settings while keeping what was imported into the Library.",
  ),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [outputContracts.setupUndo],
    exitCodes: [0, 11, 12, 64],
    interactive: false,
  }),
);
