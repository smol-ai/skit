import { defineCommand } from "./definition.js";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { runDoctor } from "../library/doctor/run.js";
import { doctorOutputContracts } from "../library/doctor/output.js";

import { CommandMetadata } from "./metadata.js";

import { enableOutputContracts } from "../library/enable.js";
import { inventoryRootOptions, localFlags } from "./parameters.js";
import { promptsAllowed } from "../terminal/interactivity.js";

export const doctorCliCommand = defineCommand(
  "doctor",
  {
    ...localFlags,
    days: Flag.Int("days").pipe(
      Flag.filter(
        (days) => days >= 1 && days <= 3650,
        () => "Days must be between 1 and 3650.",
      ),
      Flag.withDefault(14),
      Flag.withDescription("Review this many rolling days of local skill activity (1–3650)."),
    ),
    reportOnly: Flag.Boolean("report-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Show diagnostics without interactive skill cleanup."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Preview interactive cleanup without disabling skills."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;
      yield* runDoctor({
        options: { ...inventoryRootOptions(input, paths), cwd: process.cwd() },
        days: input.days,
        dryRun: input.dryRun,
        interactive: !input.reportOnly && promptsAllowed({ json: input.json }),
      });
    }),
).pipe(
  Command.withDescription(
    "Diagnose local skills and interactively review over-budget skill context.",
  ),
  Command.withExamples([{ command: "skit doctor" }]),
  Command.annotate(CommandMetadata, {
    interactive: true,
    effects: {
      capabilities: ["filesystem.read", "filesystem.write", "process.execute"],
      subprocesses: [
        "codex --version",
        "codex app-server",
        "claude --version",
        "claude --print --input-format stream-json --output-format stream-json",
        "opencode --version",
        "node (bounded OpenCode capture)",
        "opencode debug skill",
        "devin --version",
        "devin skills list --json",
      ],
    },
    outputSchemas: [
      doctorOutputContracts.doctor,
      enableOutputContracts.disablePlan,
      enableOutputContracts.disable,
    ],
  }),
);
