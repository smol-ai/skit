import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { presentDoctorCleanup, doctorOutputContracts, doctorCommand } from "../library/doctor.js";
import { Renderer } from "../terminal/renderer.js";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";

import { enableOutputContracts } from "../library/enable.js";
import { inventoryRootOptions, localFlags } from "./parameters.js";
import { encodeResult as result } from "./encode-result.js";
import { promptsAllowed } from "../terminal/interactivity.js";

export const doctorCliCommand = Command.make(
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
    handleLibraryCommand(
      Effect.gen(function* () {
        const paths = yield* SkitConfiguration;

        const selectedHome = paths.skitHome;
        const options = {
          ...inventoryRootOptions(input, paths),
          libraryHome: selectedHome,
        };
        const renderer = yield* Renderer;
        const value = yield* doctorCommand(options);
        yield* renderer.result(
          result("doctor", doctorOutputContracts.doctor, value, value.ok ? undefined : 12),
        );
        if (!input.reportOnly && promptsAllowed({ json: input.json })) {
          const changed = yield* presentDoctorCleanup(
            value.listing_budgets,
            options,
            input.days,
            input.dryRun,
          ).pipe(Effect.catchTag("PromptCancelled", () => Effect.succeed(false)));
          if (changed) {
            const checked = yield* doctorCommand(options);
            yield* renderer.result(
              result("doctor", doctorOutputContracts.doctor, checked, checked.ok ? 0 : 12),
            );
          }
        }
      }),
      Option.getOrUndefined(input.home),
    ),
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
    exitCodes: [0, 11, 12, 64, 65],
  }),
);
