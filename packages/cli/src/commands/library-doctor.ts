import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { presentDoctorCleanup } from "../library/doctor/cleanup.js";
import { doctorOutputContracts } from "../library/doctor/output.js";
import * as Library from "@smolai/skit-core/library";
import { libraryDoctorReport, inspectNativeDiscovery } from "@smolai/skit-core/library/inventory";
import { Renderer } from "../terminal/renderer.js";

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
    Effect.gen(function* () {
      const paths = yield* SkitConfiguration;
      const options = inventoryRootOptions(input, paths);
      const renderer = yield* Renderer;
      const library = yield* Library.Service;
      /** Diagnose the freshly saved inventory; the report itself is pure. */
      const doctor = Effect.gen(function* () {
        const inventory = yield* renderer.withStatus(
          "Scanning harness installations",
          library.inventory.refresh,
        );
        const native = yield* renderer.withStatus(
          "Checking native harness skill discovery",
          inspectNativeDiscovery(inventory, { ...options, cwd: process.cwd() }),
        );
        return { ...libraryDoctorReport(inventory), ...native };
      });
      const value = yield* doctor;
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
          const checked = yield* doctor;
          yield* renderer.result(
            result("doctor", doctorOutputContracts.doctor, checked, checked.ok ? 0 : 12),
          );
        }
      }
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
    exitCodes: [0, 11, 12, 64, 65],
  }),
);
