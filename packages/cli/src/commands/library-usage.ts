import { SkitConfiguration } from "@smolai/skit-core/platform";
import * as Library from "@smolai/skit-core/library";
import { UsageHarness } from "@smolai/skit-core/library/usage";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { scanLocalUsage } from "../library/usage/scan.js";
import { usageOutputContracts } from "../library/usage/output.js";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";

import { homeFlag, jsonFlag, optionalString } from "./parameters.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

export const usageCliCommand = Command.make(
  "usage",
  {
    json: jsonFlag,
    home: homeFlag,
    days: Flag.Int("days").pipe(
      Flag.withDefault(7),
      Flag.withDescription("Scan this many rolling days (1–3650)."),
    ),
    harness: Flag.Literals("harness", ["all", ...UsageHarness.literals]).pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Select local transcript harnesses."),
    ),
    project: optionalString("project", "Only events recorded in this project directory."),
    end: optionalString("end", "End timestamp, exclusive; defaults to now."),
    codexHome: optionalString(
      "codex-home",
      "Override the Codex transcript home (not the skills directory).",
    ),
    claudeHome: optionalString(
      "claude-home",
      "Override the Claude transcript home (not the skills directory).",
    ),
  },
  (input) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;
        const renderer = yield* Renderer;
        const library = yield* Library.Service;
        const installedSkills = yield* library.installedSkills;
        const report = yield* renderer.withStatus(
          "Scanning local transcripts",
          scanLocalUsage(installedSkills, {
            userHome: paths.userHome,
            harness: input.harness,
            homes: {
              codex: Option.getOrUndefined(input.codexHome),
              "claude-code": Option.getOrUndefined(input.claudeHome),
            },
            days: input.days,
            end: Option.getOrUndefined(input.end),
            project: Option.getOrUndefined(input.project),
            progress: (completed, total) =>
              renderer.updateStatus(`Scanning local transcripts: ${completed}/${total} files`),
          }),
        );
        yield* renderer.result(result("usage", usageOutputContracts.usage, report));
      }),
      input,
    ),
).pipe(
  Command.withDescription(
    "Experimental: show skill activity from local Claude and Codex transcripts.",
  ),
  Command.withExamples([
    { command: "skit usage" },
    { command: "skit usage --days 30 --harness codex" },
    { command: "skit usage --project . --json" },
  ]),
  Command.annotate(CommandMetadata, {
    stability: "experimental",
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [usageOutputContracts.usage],
    exitCodes: [0, 12, 64, 65],
    interactive: false,
  }),
);
