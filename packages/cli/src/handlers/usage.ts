import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import { LibraryStore, UsageHarness, skillUsageLayer } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { scanLocalUsage } from "../library-application/local-usage.js";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, jsonFlag, optionalString } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import { result } from "./contracts.js";

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
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;
      return yield* handleLibraryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const store = yield* LibraryStore;
          const state = yield* store.load;
          const report = yield* renderer.withStatus(
            "Scanning local transcripts",
            scanLocalUsage(state, {
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
          yield* renderer.result(result("usage", report));
        }).pipe(Effect.provide(skillUsageLayer)),
      );
    }).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(input.home)))),
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
    outputSchemas: [outputContracts.usage],
    exitCodes: [0, 12, 64, 65],
    interactive: false,
  }),
);
