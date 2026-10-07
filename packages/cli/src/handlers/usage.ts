import { LibraryStore, SkillUsage, skillUsageLayer } from "@smolai/skit-core";
import { Config, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { handleReadOnlyCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { homeFlag, homePath, jsonFlag, optionalString } from "../commands/parameters.js";
import { InvalidArgument } from "../presentation/command-errors.js";
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
    harness: Flag.Literals("harness", ["all", "codex", "claude-code"]).pipe(
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
    handleReadOnlyCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const usage = yield* SkillUsage;
        const store = yield* LibraryStore;
        const state = yield* store.load;
        const codex =
          Option.getOrUndefined(input.codexHome) ??
          (yield* Config.String("CODEX_HOME").pipe(Config.withDefault(join(homedir(), ".codex"))));
        const claude =
          Option.getOrUndefined(input.claudeHome) ??
          (yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
            Config.withDefault(join(homedir(), ".claude")),
          ));
        const roots = [
          ...(input.harness === "all" || input.harness === "codex"
            ? [
                { harness: "codex" as const, root: join(resolve(codex), "sessions") },
                { harness: "codex" as const, root: join(resolve(codex), "archived_sessions") },
              ]
            : []),
          ...(input.harness === "all" || input.harness === "claude-code"
            ? [{ harness: "claude-code" as const, root: join(resolve(claude), "projects") }]
            : []),
        ];
        const projections = state.projections.flatMap((projection) => {
          const skill = state.skills.find((s) => s.skill_id === projection.skill_id);
          return skill
            ? [{ path: projection.path, skillId: skill.skill_id, name: skill.name }]
            : [];
        });
        const report = yield* renderer.withStatus(
          "Scanning local transcripts",
          usage
            .scan({
              roots,
              days: input.days,
              end: Option.getOrUndefined(input.end),
              project: Option.getOrUndefined(input.project),
              projections,
              progress: (completed, total) =>
                renderer.updateStatus(`Scanning local transcripts: ${completed}/${total} files`),
            })
            .pipe(
              Effect.catchTag("InvalidUsageOptions", (error) =>
                Effect.fail(new InvalidArgument({ message: error.message })),
              ),
            ),
        );
        yield* renderer.result(result("usage", outputContracts.usage, report));
      }).pipe(Effect.provide(skillUsageLayer)),
      homePath(input.home),
    ),
).pipe(
  Command.withDescription("Show observed skill activity from local Claude and Codex transcripts."),
  Command.withExamples([
    { command: "skit usage" },
    { command: "skit usage --days 30 --harness codex" },
    { command: "skit usage --project . --json" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [outputContracts.usage],
    exitCodes: [0, 64],
    interactive: false,
  }),
);
