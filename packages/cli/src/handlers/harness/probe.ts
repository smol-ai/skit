import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { jsonFlag } from "../../commands/parameters.js";
import { probeRequestedHarnessesEffect } from "../../harness/probe.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

const harness = Argument.string("harness").pipe(Argument.optional);

export const harnessProbeCliCommand = Command.make(
  "probe",
  { harness, json: jsonFlag },
  ({ harness }) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const probes = yield* probeRequestedHarnessesEffect(Option.getOrUndefined(harness));
        const failed = probes.some((probe) => probe.status === "failed");
        yield* renderer.result(
          result(
            "harnessProbe",
            outputContracts.experimentalHarnessProbe,
            { probes },
            failed ? 12 : undefined,
          ),
        );
      }),
    ),
).pipe(
  Command.withDescription("Probe installed harness executables and product versions."),
  Command.withExamples([
    { command: "skit harness probe" },
    { command: "skit harness probe codex --json" },
  ]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: [
        "codex --version",
        "claude --version",
        "opencode --version",
        "devin --version",
      ],
    },
    outputSchemas: [outputContracts.experimentalHarnessProbe],
    exitCodes: [0, 12, 64],
    interactive: false,
  }),
);
