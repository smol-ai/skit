import { Effect } from "effect";
import { cliBuild } from "../build-info.js";
import { ReleaseChecker, releaseCheckerLive } from "../releases/checker.js";
import { Command } from "effect/cli";
import { handleReadOnlyCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import { result } from "./contracts.js";

export const versionCliCommand = Command.make("version", { json: jsonFlag }, () =>
  handleReadOnlyCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const checker = yield* ReleaseChecker;
      const update = yield* checker.check(cliBuild, true);
      yield* renderer.result(
        result("version", outputContracts.versionReport, {
          version: cliBuild.version,
          build: cliBuild,
          update,
        }),
      );
    }).pipe(Effect.provide(releaseCheckerLive)),
  ),
).pipe(
  Command.withDescription("Show build details and check npm for an upgrade."),
  Command.withExamples([{ command: "skit version" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.versionReport],
    exitCodes: [0],
    interactive: false,
  }),
);
