import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { auditLocalCapabilitiesV1Alpha3Effect, type AuditOptions } from "../audit/local.js";
import { handleCommand } from "../application.js";
import { CommandMetadata } from "../commands/metadata.js";
import { outputContracts } from "../commands/output-contracts.js";
import { jsonFlag, optionalString } from "../commands/parameters.js";
import { Renderer } from "../presentation/renderer.js";
import { result } from "./contracts.js";

export const auditCommand = Effect.fn("CLI.audit")(function* (options: AuditOptions = {}) {
  const renderer = yield* Renderer;
  return yield* renderer.withStatus(
    "Auditing local capabilities",
    auditLocalCapabilitiesV1Alpha3Effect(options),
  );
});

const auditSubprocesses = [
  "claude plugin list --json",
  "codex plugin list --json",
  "codex mcp list --json",
] as const;

const auditHome = optionalString("home", "Override the audited home directory.");
const auditCwd = optionalString("cwd", "Evaluate project state from this directory.");
const verbose = Flag.boolean("verbose").pipe(
  Flag.withDescription("Show complete inventory tables."),
  Flag.withDefault(false),
);
const probe = Flag.choice("probe", ["claude", "codex"]).pipe(
  Flag.withDescription("Run a bounded Claude or Codex reconciliation probe."),
  Flag.atLeast(0),
);

export const auditCliCommand = Command.make(
  "audit",
  { home: auditHome, cwd: auditCwd, verbose, probe, json: jsonFlag },
  (input) =>
    handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* auditCommand({
          home: Option.getOrUndefined(input.home),
          cwd: Option.getOrUndefined(input.cwd),
          probes: input.probe,
          allowedSubprocesses: auditSubprocesses,
        });
        const failed = value.findings.some((finding) => finding.severity === "error");
        yield* renderer.result(
          result(
            "audit",
            outputContracts.experimentalAuditV1Alpha3,
            value,
            failed ? 12 : undefined,
          ),
          { detail: input.verbose ? "full" : "summary" },
        );
      }),
    ),
).pipe(
  Command.withDescription("Inspect local harness capabilities and configuration."),
  Command.withExamples([{ command: "skit audit --json" }, { command: "skit audit --cwd ." }]),
  Command.annotate(CommandMetadata, {
    effects: {
      capabilities: ["filesystem.read", "process.execute"],
      subprocesses: auditSubprocesses,
    },
    outputSchemas: [outputContracts.experimentalAudit, outputContracts.experimentalAuditV1Alpha3],
    exitCodes: [0, 12],
    interactive: false,
  }),
);
