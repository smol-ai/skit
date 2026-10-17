import { SkitConfiguration, skitConfigurationLayer } from "../configuration/skit-configuration.js";
import {
  LibraryStore,
  SkillUsage,
  UsageHarness,
  harnessDrivers,
  skillUsageLayer,
  type UsageRoot,
} from "@smolai/skit-core";
import { Config, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { join, resolve } from "node:path";
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
      "Override the Codex transcript home (not the skills root).",
    ),
    claudeHome: optionalString(
      "claude-home",
      "Override the Claude transcript home (not the skills root).",
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;
      return yield* handleLibraryCommand(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          const usage = yield* SkillUsage;
          const store = yield* LibraryStore;
          const state = yield* store.load;
          const homes: Record<UsageHarness, Option.Option<string>> = {
            codex: input.codexHome,
            "claude-code": input.claudeHome,
          };
          const roots: UsageRoot[] = [];
          for (const harness of UsageHarness.literals) {
            if (input.harness !== "all" && input.harness !== harness) continue;
            const transcripts = harnessDrivers[harness].transcripts;
            const home =
              Option.getOrUndefined(homes[harness]) ??
              (yield* Config.String(transcripts.home.variable).pipe(
                Config.withDefault(join(paths.userHome, transcripts.home.directory)),
              ));
            for (const directory of transcripts.directories)
              roots.push({ harness, root: join(resolve(home), directory) });
          }
          const projections = state.projections.flatMap((projection) => {
            const skill = state.skills.find((s) => s.skill_id === projection.skill_id);
            return skill
              ? [{ path: projection.path, skillId: skill.skill_id, name: skill.name }]
              : [];
          });
          const report = yield* renderer.withStatus(
            "Scanning local transcripts",
            usage.scan({
              roots,
              days: input.days,
              end: Option.getOrUndefined(input.end),
              project: Option.getOrUndefined(input.project),
              projections,
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
    exitCodes: [0, 64],
    interactive: false,
  }),
);
