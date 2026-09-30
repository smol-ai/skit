import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { join } from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { LibraryDoctorReport, SourceProcess } from "@smolai/skit-core";
import { probeHarnessEffect, type ProbeableHarness } from "../../harness/probe.js";
import { CodexDoctorCheck } from "./doctor-codex.js";
import { readOpenCodeV2Skills } from "./doctor-opencode-v2.js";

export class HarnessDiscoveryFailure extends Schema.TaggedError<HarnessDiscoveryFailure>()(
  "HarnessDiscoveryFailure",
  { message: Schema.String },
) {}

export const HarnessDoctorSkill = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  displayName: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Schema.String),
  triggers: Schema.optionalKey(Schema.Array(Schema.String)),
  warnings: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
});
export type HarnessDoctorSkill = typeof HarnessDoctorSkill.Type;
export const HarnessDoctorCheck = Schema.Struct({
  harness: Schema.Literals(["claude-code", "opencode", "devin"]),
  status: Schema.Literals(["checked", "missing", "failed", "skipped"]),
  cwd: Schema.String,
  version: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  coverage: Schema.Literals(["callable-commands", "resolved-skills", "native-skills"]),
  limitations: Schema.Array(Schema.String),
  skills: Schema.Array(HarnessDoctorSkill),
  warnings: Schema.Array(Schema.String),
});
export type HarnessDoctorCheck = typeof HarnessDoctorCheck.Type;
export const DoctorReport = Schema.Struct({
  ...LibraryDoctorReport.fields,
  codex: CodexDoctorCheck,
  harnesses: Schema.Array(HarnessDoctorCheck),
});

const OpenCodeSkills = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    location: Schema.String,
    // Deliberately exclude content: discovery metadata belongs in diagnostics, bodies do not.
  }),
);
const DevinSkills = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    description: Schema.NullOr(Schema.String),
    base_dir: Schema.String,
    display_name: Schema.NullOr(Schema.String),
    provider: Schema.String,
    triggers: Schema.Array(Schema.String),
    warnings: Schema.Array(Schema.String),
    errors: Schema.Array(Schema.String),
  }),
);
const ClaudeCommand = Schema.Struct({ name: Schema.String, description: Schema.String });
const ClaudeEnvelope = Schema.Struct({
  type: Schema.String,
  response: Schema.optionalKey(
    Schema.Struct({
      request_id: Schema.String,
      subtype: Schema.String,
      error: Schema.optionalKey(Schema.String),
      response: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

export const decodeOpenCodeSkills = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OpenCodeSkills),
);
export const decodeDevinSkills = Schema.decodeUnknownEffect(Schema.fromJsonString(DevinSkills));

/** SDK initialize only. No user message, model turn, hooks, or MCP server startup. */
export const readClaudeCommands = Effect.fn("Doctor.readClaudeCommands")(function* (
  executable: string,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          executable,
          [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--settings",
            '{"disableAllHooks":true}',
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
          ],
          {
            cwd,
            stderr: "ignore",
            stdin: {
              stream: Stream.succeed(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "control_request",
                    request_id: "skit-doctor",
                    request: { subtype: "initialize", hooks: {} },
                  }) + "\n",
                ),
              ),
              endOnDone: false,
            },
          },
        ),
      );
      let size = 0;
      const envelope = yield* child.stdout.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.length;
          return size > 4_000_000
            ? Effect.fail(
                new HarnessDiscoveryFailure({ message: "Claude discovery exceeded 4 MB" }),
              )
            : Effect.succeed(chunk);
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeEnvelope))(line),
        ),
        Stream.filter(
          (message) =>
            message.type === "control_response" && message.response?.request_id === "skit-doctor",
        ),
        Stream.runHead,
      );
      if (Option.isNone(envelope) || !envelope.value.response)
        return yield* new HarnessDiscoveryFailure({
          message: "Claude exited without an initialize response",
        });
      const response = envelope.value.response;
      if (response.subtype !== "success")
        return yield* new HarnessDiscoveryFailure({
          message: response.error ?? "Claude initialize failed",
        });
      return (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ commands: Schema.Array(ClaudeCommand) }),
      )(response.response)).commands;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: 15_000,
      orElse: () =>
        Effect.fail(
          new HarnessDiscoveryFailure({ message: "Claude discovery timed out after 15 seconds" }),
        ),
    }),
  );
});

// OpenCode exits before flushing large piped JSON. A regular file makes its write synchronous.
// The wrapper has its own shorter timeout and never force-exits while forwarding the result.
const openCodeCapture = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const [executable, file] = process.argv.slice(1);
const fd = fs.openSync(file, 'w', 0o600);
const result = spawnSync(executable, ['debug','skill','--print-logs','--log-level','WARN'], {
  stdio: ['ignore',fd,'pipe'], timeout: 14000, maxBuffer: 32000
});
const size = fs.fstatSync(fd).size;
fs.closeSync(fd);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error || result.status !== 0) {
  process.stderr.write(String(result.error || ('exit ' + result.status)));
  process.exitCode = 1;
} else if (size > 4000000) {
  process.stderr.write('OpenCode discovery exceeded 4 MB');
  process.exitCode = 1;
} else process.stdout.write(fs.readFileSync(file));
`;

export const readNativeSkills = Effect.fn("Doctor.readNativeSkills")(function* (
  harness: "opencode" | "devin",
  executable: string,
  cwd: string,
  version?: string,
) {
  if (harness === "opencode" && version?.startsWith("2."))
    return yield* readOpenCodeV2Skills(executable, cwd);
  const sourceProcess = yield* SourceProcess;
  const options = { cwd, timeoutMs: 15_000, maxOutputBytes: 4_000_000, maxErrorBytes: 32_000 };
  const output =
    harness === "opencode"
      ? yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "skit-opencode-discovery-",
            });
            return yield* sourceProcess.output(
              process.execPath,
              ["-e", openCodeCapture, executable, join(directory, "skills.json")],
              options,
            );
          }),
        )
      : yield* sourceProcess.output(executable, ["skills", "list", "--json"], options);
  if (output.exitCode !== 0)
    return yield* new HarnessDiscoveryFailure({
      message: `${harness} discovery exited ${output.exitCode}${output.stderr.trim() ? `: ${output.stderr.trim()}` : ""}`,
    });
  const text = new TextDecoder().decode(output.stdout);
  const skills: HarnessDoctorSkill[] =
    harness === "opencode"
      ? (yield* decodeOpenCodeSkills(text)).map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          path: skill.location,
          warnings: [],
          errors: [],
        }))
      : (yield* decodeDevinSkills(text)).map((skill) => ({
          name: skill.name,
          ...(skill.description === null ? {} : { description: skill.description }),
          path: skill.base_dir,
          ...(skill.display_name === null ? {} : { displayName: skill.display_name }),
          provider: skill.provider,
          triggers: skill.triggers,
          warnings: skill.warnings,
          errors: skill.errors,
        }));
  return { skills, warnings: output.stderr.trim() ? [output.stderr.trim()] : [] };
});

export const doctorHarnessCheck = Effect.fn("Doctor.harness")(function* (
  harness: Exclude<ProbeableHarness, "codex">,
  cwd: string,
  overrideRoot?: string | readonly string[],
) {
  const coverage: HarnessDoctorCheck["coverage"] =
    harness === "claude-code"
      ? "callable-commands"
      : harness === "opencode"
        ? "resolved-skills"
        : "native-skills";
  const limitations =
    harness === "claude-code"
      ? [
          "Callable commands only; may include legacy commands and bundled commands. Non-user-invocable skills and file paths are not exposed. Hooks and MCP startup are disabled.",
        ]
      : harness === "opencode"
        ? [
            "Resolved skills only: duplicate names can replace earlier entries. Native warnings may reveal collisions; the final list cannot prove their absence. Skill bodies are omitted.",
          ]
        : ["Native list semantics; completeness across duplicate paths has not been established."];
  const empty = { harness, cwd, coverage, limitations, skills: [], warnings: [] };
  if (typeof overrideRoot === "string" ? Boolean(overrideRoot) : Boolean(overrideRoot?.length))
    return {
      ...empty,
      status: "skipped" as const,
      detail:
        "Custom projection roots do not describe the harness's native discovery. Run doctor without root overrides.",
    };
  const probe = yield* probeHarnessEffect(harness);
  const version = probe.version ? { version: probe.version } : {};
  if (probe.status !== "installed" || !probe.executablePath)
    return {
      ...empty,
      ...version,
      status: probe.status === "missing" ? ("missing" as const) : ("failed" as const),
      detail: probe.error ?? "Harness unavailable",
    };
  const executable = probe.executablePath;
  const native = {
    ...empty,
    ...version,
    limitations:
      harness === "opencode" && probe.version?.startsWith("2.")
        ? [
            "Registered skills after discovery plugin activation and three stable metadata snapshots. Duplicate filesystem IDs are resolved by native precedence without warnings; equal display names can coexist. Skill bodies are omitted.",
          ]
        : limitations,
  };
  return yield* Effect.gen(function* () {
    if (harness === "claude-code") {
      const commands = yield* readClaudeCommands(executable, cwd);
      return {
        ...native,
        status: "checked" as const,
        skills: commands.map((command) => ({ ...command, warnings: [], errors: [] })),
      };
    }
    const result = yield* readNativeSkills(harness, executable, cwd, probe.version ?? undefined);
    return { ...native, ...result, status: "checked" as const };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ ...native, status: "failed" as const, detail: String(error) }),
    ),
  );
});
