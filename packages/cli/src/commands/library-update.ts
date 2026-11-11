import { defineCommand } from "./definition.js";
import { updateOutputContracts, sourceUpdateOutput } from "../library/update/output.js";
import { MissingRequirement } from "./input-failures.js";
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

const subject = Argument.String("skill-or-collection").pipe(
  Argument.withDescription(
    "Skill or Collection Reference to update; omit it to update all Sources.",
  ),
  Argument.optional,
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Report changes without applying them."),
  Flag.withDefault(false),
);

const installedEditOption = "from";
const from = Flag.String(installedEditOption).pipe(
  Flag.withDescription(
    "Import edits from the installed skill folder at this path; requires <skill>.",
  ),
  Flag.optional,
);

const installedEditRequirement = {
  command: `skit update --${installedEditOption}`,
  requires: "<skill>",
};

export const updateCliCommand = defineCommand(
  "update",
  { subject, dryRun, from, ...localFlags },
  (input) =>
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      const query = Option.getOrUndefined(input.subject);
      const installedSkillPath = Option.getOrUndefined(input.from);
      if (installedSkillPath !== undefined) {
        if (query === undefined)
          return yield* new MissingRequirement({ reason: { _tag: "InstalledEditSubject" } });
        const value = yield* renderer.withStatus(
          input.dryRun
            ? "Inspecting changed installed-skill bytes"
            : "Importing changed installed skill files",
          Effect.gen(function* () {
            const prepared = yield* library.edit(query, installedSkillPath);
            return input.dryRun
              ? result(
                  "installedEditPlan",
                  updateOutputContracts.installedEditPlan,
                  prepared.preview,
                )
              : result(
                  "installedEdit",
                  updateOutputContracts.installedEdit,
                  yield* prepared.apply(),
                );
          }),
        );
        return yield* renderer.result(value);
      }
      if (input.dryRun) {
        const value = yield* renderer.withStatus(
          "Checking Sources",
          library.previewSourceUpdates(query, inspectLibrarySource),
        );
        return yield* renderer.result(
          result("updatePlan", updateOutputContracts.updatePlan, value),
        );
      }
      const value = yield* library.update(query, yield* updateAdapters);
      yield* renderer.result(
        result("update", updateOutputContracts.update, sourceUpdateOutput(value)),
      );
    }),
).pipe(
  Command.withDescription("Update sources and installed skills; sync connected Author Workspaces."),
  Command.withExamples([
    { command: "skit update --dry-run" },
    { command: "skit update my-skill --from ~/.claude/skills/my-skill --dry-run" },
  ]),
  Command.annotate(CommandMetadata, {
    handlerRules: [
      `${installedEditRequirement.command} requires ${installedEditRequirement.requires}`,
    ],
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
    outputSchemas: [
      updateOutputContracts.update,
      updateOutputContracts.updatePlan,
      updateOutputContracts.installedEdit,
      updateOutputContracts.installedEditPlan,
    ],
    interactive: false,
  }),
);
