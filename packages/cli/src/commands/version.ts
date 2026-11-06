import { Effect } from "effect";
import { cliBuild } from "./build-info.js";
import { checkRelease } from "../platform/releases.js";
import { Command } from "effect/cli";
import { handlePlatformCommand } from "./handler.js";
import { CommandMetadata } from "./metadata.js";
import { outputContracts } from "./output-contracts.js";
import { jsonFlag } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { result } from "./result.js";

export const versionCliCommand = Command.make("version", { json: jsonFlag }, () =>
  handlePlatformCommand(
    Effect.gen(function* () {
      const renderer = yield* Renderer;
      const update = yield* checkRelease(cliBuild, true);
      yield* renderer.result(
        result("versionReport", {
          version: cliBuild.version,
          build: cliBuild,
          update,
        }),
      );
    }),
  ),
).pipe(
  Command.withDescription("Show build details and check npm for an upgrade."),
  Command.withExamples([{ command: "skit version" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write", "network.read"] },
    outputSchemas: [outputContracts.versionReport],
    exitCodes: [0, 64],
    interactive: false,
  }),
);
