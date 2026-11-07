import { updateOutputContracts } from "../library/update/output.js";
import { updateExitCode } from "../library/update/exit-code.js";
import { EditImportMissing } from "@smolai/skit-core/library/edit";
import * as Library from "@smolai/skit-core/library";
import { inspectLibrarySource } from "../library/source.js";
import { updateAdapters } from "../library/update/adapters.js";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import {
  CommandMetadata,
  credentialStoreReadSubprocesses,
  sourceFetchSubprocesses,
} from "./metadata.js";

import { localFlags } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

const subject = Argument.String("skill-or-collection").pipe(Argument.optional);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);

const fromProjection = Flag.String("from-projection").pipe(
  Flag.withDescription("Import edits from this installed skill, given by its ID, harness or path."),
  Flag.optional,
);

export const updateCliCommand = Command.make(
  "update",
  { subject, dryRun, fromProjection, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      const query = Option.getOrUndefined(input.subject);
      const installedSkillSelector = Option.getOrUndefined(input.fromProjection);
      if (installedSkillSelector !== undefined) {
        if (query === undefined)
          return yield* new EditImportMissing({
            message: "A Skill is required with --from-projection",
          });
        const value = yield* renderer.withStatus(
          input.dryRun
            ? "Inspecting changed installed-skill bytes"
            : "Retaining changed installed-skill bytes",
          Effect.gen(function* () {
            const prepared = yield* library.edit(query, installedSkillSelector);
            return input.dryRun
              ? result(
                  "projectionRetentionPlan",
                  updateOutputContracts.projectionRetentionPlan,
                  prepared.preview,
                )
              : result(
                  "projectionRetention",
                  updateOutputContracts.projectionRetention,
                  yield* prepared.apply(),
                );
          }),
        );
        return yield* renderer.result(value);
      }
      if (input.dryRun) {
        const value = yield* renderer.withStatus(
          "Checking Source observations",
          library.previewSourceUpdates(query, inspectLibrarySource),
        );
        return yield* renderer.result(
          result("updatePlan", updateOutputContracts.updatePlan, value),
        );
      }
      const value = yield* library.update(query, yield* updateAdapters);
      yield* renderer.result(
        result("update", updateOutputContracts.update, value, updateExitCode(value)),
      );
    }),
).pipe(
  Command.withDescription("Update sources from their recorded origins."),
  Command.withExamples([
    { command: "skit update --dry-run" },
    { command: "skit update my-skill --from-projection claude-code --dry-run" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "network.read", "process.execute"],
      subprocesses: [...sourceFetchSubprocesses, ...credentialStoreReadSubprocesses],
    },
    outputSchemas: [
      updateOutputContracts.update,
      updateOutputContracts.updatePlan,
      updateOutputContracts.projectionRetention,
      updateOutputContracts.projectionRetentionPlan,
    ],
    exitCodes: [0, 1, 11, 12, 64, 65],
    interactive: false,
  }),
);
