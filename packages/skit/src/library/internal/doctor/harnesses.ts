import { DiscoveryProtocol } from "../../../harnesses/discovery-contracts.js";
import { HarnessProbeFailure } from "../../../harnesses/probe-failures.js";
import type { LibraryInventory } from "../../library-state.js";
import { LibraryDoctorReport } from "../../inventory/doctor-report.js";
import {
  DuplicateCopy,
  scanSkillsDirectory,
  readableSkillsDirectories,
  DuplicateScanError,
  type InventoryRootOptions,
} from "../../routing/index.js";

import { Effect, FileSystem, Option, Record, Schema, Stream } from "effect";
import { dirname, join, resolve } from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  HarnessName,
  readClaudeListingSnapshot,
  ListingBudget,
  probeHarness,
} from "../../../harnesses/index.js";
import { SourceProcess, type SourceProcessResult } from "../../../platform/index.js";

import { CodexDoctorCheck, doctorCodexCheck } from "./codex.js";
import { readOpenCodeV2Skills } from "./opencode.js";
import { HarnessDiscoveryFailed } from "../../../harnesses/discovery-failures.js";

const HarnessDoctorSkill = Schema.Struct({
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
type HarnessDoctorSkill = typeof HarnessDoctorSkill.Type;
/** The Harnesses doctor checks through their own discovery; Codex has its own check. */
const NativeDoctorHarness = HarnessName.pick(["claude-code", "opencode", "devin"]);
type NativeDoctorHarness = typeof NativeDoctorHarness.Type;
const NativeDiscoveryFinding = Schema.Union([
  Schema.TaggedStruct("Warning", { message: Schema.String }),
  Schema.TaggedStruct("NameCollision", {
    name: Schema.String,
    paths: Schema.Array(Schema.String),
    selectedPath: Schema.optionalKey(Schema.String),
  }),
]);
type NativeDiscoveryFinding = typeof NativeDiscoveryFinding.Type;
const warningFindings = (warnings: readonly string[]): NativeDiscoveryFinding[] =>
  warnings
    .flatMap((warning) => warning.split("\n").filter(Boolean))
    .map((message) => ({ _tag: "Warning", message }));

export const HarnessDoctorCheck = Schema.Struct({
  harness: NativeDoctorHarness,
  status: Schema.Literals(["checked", "missing", "failed", "skipped"]),
  cwd: Schema.String,
  version: Schema.optionalKey(Schema.String),
  rootOverrides: Schema.optionalKey(Schema.Array(Schema.String)),
  protocol: Schema.optionalKey(
    DiscoveryProtocol.pick([
      "claude-control-initialize",
      "opencode-debug-skill",
      "opencode-http-v2",
      "devin-skills-list",
    ]),
  ),
  probeFailure: Schema.optionalKey(HarnessProbeFailure),
  discoveryFailure: Schema.optionalKey(HarnessDiscoveryFailed),
  coverage: Schema.Literals(["callable-commands", "resolved-skills", "native-skills"]),
  skills: Schema.Array(HarnessDoctorSkill),
  locations: Schema.optionalKey(Schema.Array(DuplicateCopy)),
  aliasErrors: Schema.optionalKey(Schema.Array(DuplicateScanError)),
  findings: Schema.Array(NativeDiscoveryFinding),
  warnings: Schema.Array(Schema.String),
});
export type HarnessDoctorCheck = typeof HarnessDoctorCheck.Type;
export const DoctorReport = Schema.Struct({
  ...LibraryDoctorReport.fields,
  codex: CodexDoctorCheck,
  listing_budgets: Schema.Array(ListingBudget),
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

const decodeOpenCodeSkills = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeSkills));
const decodeDevinSkills = Schema.decodeUnknownEffect(Schema.fromJsonString(DevinSkills));

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
                new HarnessDiscoveryFailed({
                  harness: "claude-code",
                  cwd,
                  reason: {
                    _tag: "OutputLimitExceeded",
                    phase: "inventory",
                    limitBytes: 4_000_000,
                    actualBytes: size,
                  },
                }),
              )
            : Effect.succeed(chunk);
        }),
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
        Stream.mapEffect((line) =>
          Schema.decodeEffect(Schema.fromJsonString(ClaudeEnvelope))(line),
        ),
        Stream.filter(
          (message) =>
            message.type === "control_response" && message.response?.request_id === "skit-doctor",
        ),
        Stream.runHead,
      );
      if (Option.isNone(envelope) || !envelope.value.response)
        return yield* new HarnessDiscoveryFailed({
          harness: "claude-code",
          cwd,
          reason: { _tag: "ResponseMissing", method: "initialize" },
        });
      const response = envelope.value.response;
      if (response.subtype !== "success")
        return yield* new HarnessDiscoveryFailed({
          harness: "claude-code",
          cwd,
          reason: {
            _tag: "RemoteError",
            method: "initialize",
            ...(response.error === undefined ? {} : { diagnostic: response.error }),
          },
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
          new HarnessDiscoveryFailed({
            harness: "claude-code",
            cwd,
            reason: { _tag: "TimedOut", timeoutMs: 15_000 },
          }),
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
process.stdout.write(JSON.stringify({
  exitCode: result.status,
  signal: result.signal,
  size,
  ...(result.error ? {error:{message:result.error.message,...(result.error.code ? {code:result.error.code} : {})}} : {})
}));
`;

const NATIVE_LIST_LIMITS = { timeoutMs: 15_000, maxOutputBytes: 4_000_000, maxErrorBytes: 32_000 };

const nativeListWarnings = (output: SourceProcessResult) =>
  output.stderr.trim() ? [output.stderr.trim()] : [];

/** OpenCode V1's resolved skill list. */
const readOpenCodeSkills = Effect.fn("Doctor.readOpenCodeSkills")(function* (
  executable: string,
  cwd: string,
) {
  const sourceProcess = yield* SourceProcess;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-opencode-discovery-" });
      const file = join(directory, "skills.json");
      const output = yield* sourceProcess.output(
        process.execPath,
        ["-e", openCodeCapture, executable, file],
        { cwd, ...NATIVE_LIST_LIMITS },
      );
      const arguments_ = ["debug", "skill", "--print-logs", "--log-level", "WARN"];
      if (output.exitCode !== 0)
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "ExitCode",
            command: process.execPath,
            arguments: ["-e", openCodeCapture, executable, file],
            exitCode: output.exitCode,
            stderr: output.stderr,
          },
        });
      const capture = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            exitCode: Schema.NullOr(Schema.Int),
            signal: Schema.NullOr(Schema.String),
            size: Schema.Int,
            error: Schema.optionalKey(
              Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.String }),
            ),
          }),
        ),
      )(new TextDecoder().decode(output.stdout));
      if (capture.error)
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "ProcessFailed",
            command: executable,
            arguments: arguments_,
            signal: capture.signal,
            error: capture.error,
          },
        });
      if (capture.exitCode === null)
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "ProcessEnded",
            command: executable,
            arguments: arguments_,
            signal: capture.signal,
          },
        });
      if (capture.exitCode !== 0)
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "ExitCode",
            command: executable,
            arguments: arguments_,
            exitCode: capture.exitCode,
            stderr: output.stderr,
          },
        });
      if (capture.size > 4_000_000)
        return yield* new HarnessDiscoveryFailed({
          harness: "opencode",
          cwd,
          reason: {
            _tag: "OutputLimitExceeded",
            phase: "inventory",
            limitBytes: 4_000_000,
            actualBytes: capture.size,
          },
        });
      const skills: HarnessDoctorSkill[] = (yield* decodeOpenCodeSkills(
        yield* fs.readFileString(file),
      )).map((skill) => ({
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        path: skill.location,
        warnings: [],
        errors: [],
      }));
      return { skills, warnings: nativeListWarnings(output) };
    }),
  );
});

/** Devin's own skill list, with its per-skill diagnostics. */
const readDevinSkills = Effect.fn("Doctor.readDevinSkills")(function* (
  executable: string,
  cwd: string,
) {
  const output = yield* (yield* SourceProcess).output(executable, ["skills", "list", "--json"], {
    cwd,
    ...NATIVE_LIST_LIMITS,
  });
  if (output.exitCode !== 0)
    return yield* new HarnessDiscoveryFailed({
      harness: "devin",
      cwd,
      reason: {
        _tag: "ExitCode",
        command: executable,
        arguments: ["skills", "list", "--json"],
        exitCode: output.exitCode,
        stderr: output.stderr,
      },
    });
  const skills: HarnessDoctorSkill[] = (yield* decodeDevinSkills(
    new TextDecoder().decode(output.stdout),
  )).map((skill) => ({
    name: skill.name,
    ...(skill.description === null ? {} : { description: skill.description }),
    path: skill.base_dir,
    ...(skill.display_name === null ? {} : { displayName: skill.display_name }),
    provider: skill.provider,
    triggers: skill.triggers,
    warnings: skill.warnings,
    errors: skill.errors,
  }));
  return { skills, warnings: nativeListWarnings(output) };
});

const openCodeDriver = (version: string | undefined) =>
  version?.startsWith("2.") === true
    ? { protocol: "opencode-http-v2" as const, read: readOpenCodeV2Skills }
    : { protocol: "opencode-debug-skill" as const, read: readOpenCodeSkills };

/** How doctor reads one Harness's own Skill discovery, and what that reading can and cannot show. */
export interface NativeDiscovery {
  readonly coverage: HarnessDoctorCheck["coverage"];
  readonly protocol: (version?: string) => Exclude<DiscoveryProtocol, "codex-app-server">;
  readonly read: (
    executable: string,
    cwd: string,
    version?: string,
  ) => Effect.Effect<
    { readonly skills: readonly HarnessDoctorSkill[]; readonly warnings: readonly string[] },
    Effect.Error<
      ReturnType<
        | typeof readClaudeCommands
        | typeof readOpenCodeSkills
        | typeof readOpenCodeV2Skills
        | typeof readDevinSkills
      >
    >,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | SourceProcess
  >;
  /** Drop diagnostics that only restate SKIT's own expected installed skills. */
  readonly classifyWarnings?: (
    check: HarnessDoctorCheck,
    state: LibraryInventory,
  ) => HarnessDoctorCheck;
}

/** Codex has its own, richer check. */
export const nativeDiscovery: Record<NativeDoctorHarness, NativeDiscovery> = {
  "claude-code": {
    coverage: "callable-commands",
    protocol: () => "claude-control-initialize",
    read: (executable: string, cwd: string) =>
      readClaudeCommands(executable, cwd).pipe(
        Effect.map((commands) => ({
          skills: commands.map((command) => ({ ...command, warnings: [], errors: [] })),
          warnings: [],
        })),
      ),
  },
  opencode: {
    coverage: "resolved-skills",
    protocol: (version) => openCodeDriver(version).protocol,
    read: (executable: string, cwd: string, version?: string) =>
      openCodeDriver(version).read(executable, cwd),
    classifyWarnings: classifyOpenCodeWarnings,
  },
  devin: {
    coverage: "native-skills",
    protocol: () => "devin-skills-list",
    read: (executable: string, cwd: string) => readDevinSkills(executable, cwd),
  },
};

const doctorHarnessCheck = Effect.fn("Doctor.harness")(function* (
  harness: NativeDoctorHarness,
  cwd: string,
  overrides?: readonly string[],
) {
  const discovery = nativeDiscovery[harness];
  const coverage: HarnessDoctorCheck["coverage"] = discovery.coverage;
  const empty = {
    harness,
    cwd,
    coverage,
    findings: [],
    skills: [],
    warnings: [],
  };
  if (overrides?.some(Boolean))
    return {
      ...empty,
      status: "skipped" as const,
      rootOverrides: overrides,
    };
  const probe = yield* probeHarness(harness);
  const version = probe.version ? { version: probe.version } : {};
  if (probe.status !== "installed" || !probe.executablePath)
    return {
      ...empty,
      ...version,
      status: probe.status === "missing" ? ("missing" as const) : ("failed" as const),
      ...(probe.failure === null ? {} : { probeFailure: probe.failure }),
    };
  const native = {
    ...empty,
    ...version,
    protocol: discovery.protocol(probe.version ?? undefined),
  };
  return yield* discovery.read(probe.executablePath, cwd, probe.version ?? undefined).pipe(
    Effect.map((result) => ({
      ...native,
      ...result,
      findings: warningFindings(result.warnings),
      status: "checked" as const,
    })),
    Effect.catch((error) =>
      Effect.succeed({
        ...native,
        status: "failed" as const,
        discoveryFailure: Schema.is(HarnessDiscoveryFailed)(error)
          ? error
          : new HarnessDiscoveryFailed({
              harness,
              cwd,
              reason: { _tag: "ReadFailed", failure: error },
            }),
      }),
    ),
  );
});

/** Remove only proven, expected shared/Claude collisions from the diagnostic warnings. */
export function classifyOpenCodeWarnings(
  check: HarnessDoctorCheck,
  state: LibraryInventory,
): HarnessDoctorCheck {
  if (check.harness !== "opencode" || check.status !== "checked") return check;
  const lines = check.warnings.flatMap((warning) => warning.split("\n").filter(Boolean));
  const field = (line: string, key: string) => {
    const value = line.match(new RegExp(`(?:^|\\s)${key}=("(?:\\\\.|[^"\\\\])*"|\\S+)`))?.[1];
    if (!value) return undefined;
    try {
      return value.startsWith('"') ? String(JSON.parse(value)) : value;
    } catch {
      return undefined;
    }
  };
  const collisions = lines.map((line) => ({
    line,
    name: field(line, "name"),
    existing: field(line, "existing"),
    duplicate: field(line, "duplicate"),
  }));
  const expected = new Set<string>();
  for (const skill of check.skills) {
    if (!skill.path) continue;
    const selectedPath = resolve(skill.path);
    const agents = state.installed_skills.find(
      (installedSkill) =>
        installedSkill.destination === "agents" &&
        installedSkill.status === "installed" &&
        resolve(join(installedSkill.path, "SKILL.md")) === selectedPath,
    );
    if (!agents) continue;
    const claude = state.installed_skills.find(
      (installedSkill) =>
        installedSkill.destination === "claude" &&
        installedSkill.status === "installed" &&
        installedSkill.skill_id === agents.skill_id &&
        installedSkill.skill_version_id === agents.skill_version_id &&
        dirname(dirname(installedSkill.root)) === dirname(dirname(agents.root)),
    );
    if (!claude) continue;
    const paths = new Set([
      resolve(join(agents.path, "SKILL.md")),
      resolve(join(claude.path, "SKILL.md")),
    ]);
    const named = collisions.filter((collision) => collision.name === skill.name);
    if (
      named.length &&
      named.every(
        (collision) =>
          collision.line.includes("duplicate skill name") &&
          collision.existing &&
          collision.duplicate &&
          paths.has(resolve(collision.existing)) &&
          paths.has(resolve(collision.duplicate)),
      )
    )
      expected.add(skill.name);
  }
  const remaining = collisions.filter(
    (collision) => !collision.name || !expected.has(collision.name),
  );
  const grouped = new Map<string, Set<string>>();
  const findings: NativeDiscoveryFinding[] = [];
  for (const collision of remaining) {
    if (
      collision.line.includes("duplicate skill name") &&
      collision.name &&
      collision.existing &&
      collision.duplicate
    ) {
      const paths = grouped.get(collision.name) ?? new Set<string>();
      paths.add(collision.existing);
      paths.add(collision.duplicate);
      grouped.set(collision.name, paths);
    } else findings.push({ _tag: "Warning", message: collision.line });
  }
  return {
    ...check,
    warnings: remaining.map(({ line }) => line),
    findings: [
      ...[...grouped]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, paths]): NativeDiscoveryFinding => {
          const selectedPath = check.skills.find((skill) => skill.name === name)?.path;
          return {
            _tag: "NameCollision",
            name,
            paths: [...paths].sort(),
            ...(selectedPath ? { selectedPath } : {}),
          };
        }),
      ...findings,
    ],
  };
}

/** Diagnose native discovery against one already-refreshed Library observation. Does not acquire the writer. */
export const inspectNativeDiscovery = Effect.fn("Doctor.inspectNativeDiscovery")(function* (
  inventory: LibraryInventory,
  options: InventoryRootOptions & { readonly cwd: string },
) {
  const { cwd } = options;
  const { codex, claude, harnesses } = yield* Effect.all(
    {
      codex: doctorCodexCheck(inventory, cwd, options.overrides.codex, options),
      claude: readClaudeListingSnapshot(inventory, { ...options, cwd }),
      harnesses: Effect.forEach(
        Record.keys(nativeDiscovery),
        (harness) => doctorHarnessCheck(harness, cwd, options.overrides[harness]),
        { concurrency: 3 },
      ),
    },
    { concurrency: 3 },
  );
  const aliasErrors: DuplicateScanError[] = [];
  const locations = yield* scanSkillsDirectory(
    [
      ...readableSkillsDirectories(options, { kind: "global" }),
      ...readableSkillsDirectories(options, { kind: "repository", root: cwd }),
    ],
    { errors: aliasErrors },
  );
  const { listingBudget, ...nativeCodex } = codex;
  return {
    codex: nativeCodex,
    listing_budgets: [
      listingBudget ?? {
        _tag: "Unavailable" as const,
        harness: "codex" as const,
        cwd,
        reason:
          "discoveryFailure" in codex && codex.discoveryFailure
            ? { _tag: "DiscoveryFailed" as const, failure: codex.discoveryFailure }
            : options.overrides.codex !== undefined
              ? { _tag: "CustomRoot" as const, roots: options.overrides.codex }
              : {
                  _tag: "NativeDiscoveryUnavailable" as const,
                  status: codex.status,
                  ...("probeFailure" in codex && codex.probeFailure
                    ? { probeFailure: codex.probeFailure }
                    : {}),
                },
      },
      claude.budget,
    ],
    harnesses: harnesses.map((check) => {
      const warnings = check.warnings;
      const located = {
        ...check,
        locations: locations.filter((location) => location.harness === check.harness),
        ...(aliasErrors.length ? { aliasErrors } : {}),
        warnings,
        findings: warningFindings(warnings),
      };
      return nativeDiscovery[check.harness].classifyWarnings?.(located, inventory) ?? located;
    }),
  };
});
