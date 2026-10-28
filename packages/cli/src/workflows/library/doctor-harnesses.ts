import {
  DuplicateCopy,
  scanSkillsDirectory,
  readableSkillsDirectories,
  type DuplicateScanError,
} from "../../install/duplicates.js";
import type { InventoryRootOptions } from "../../install/roots.js";
import { Data, Effect, FileSystem, Option, Record, Schema, Stream } from "effect";
import { dirname, join, resolve } from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  HarnessName,
  type LibraryState,
  LibraryDoctorReport,
  readClaudeListingSnapshot,
  ListingBudget,
  SourceProcess,
  type SourceProcessResult,
} from "@smolai/skit-core";
import { probeHarness } from "../../harness/probe.js";
import { CodexDoctorCheck, doctorCodexCheck } from "./doctor-codex.js";
import { readOpenCodeV2Skills } from "./doctor-opencode-v2.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class HarnessDiscoveryFailure
  extends Data.TaggedError("HarnessDiscoveryFailure")<{
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Check that the Harness runs, then retry.";
}

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
/** The Harnesses doctor checks through their own discovery; Codex has its own check. */
const NativeDoctorHarness = HarnessName.pick(["claude-code", "opencode", "devin"]);
type NativeDoctorHarness = typeof NativeDoctorHarness.Type;
export const HarnessDoctorCheck = Schema.Struct({
  harness: NativeDoctorHarness,
  status: Schema.Literals(["checked", "missing", "failed", "skipped"]),
  cwd: Schema.String,
  version: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  coverage: Schema.Literals(["callable-commands", "resolved-skills", "native-skills"]),
  limitations: Schema.Array(Schema.String),
  skills: Schema.Array(HarnessDoctorSkill),
  locations: Schema.optionalKey(Schema.Array(DuplicateCopy)),
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

const NATIVE_LIST_LIMITS = { timeoutMs: 15_000, maxOutputBytes: 4_000_000, maxErrorBytes: 32_000 };

const nativeListWarnings = (output: SourceProcessResult) =>
  output.stderr.trim() ? [output.stderr.trim()] : [];

/** OpenCode V1's resolved skill list. */
export const readOpenCodeSkills = Effect.fn("Doctor.readOpenCodeSkills")(function* (
  executable: string,
  cwd: string,
) {
  const sourceProcess = yield* SourceProcess;
  const output = yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-opencode-discovery-" });
      return yield* sourceProcess.output(
        process.execPath,
        ["-e", openCodeCapture, executable, join(directory, "skills.json")],
        { cwd, ...NATIVE_LIST_LIMITS },
      );
    }),
  );
  if (output.exitCode !== 0)
    return yield* new HarnessDiscoveryFailure({
      message: `opencode discovery exited ${output.exitCode}${output.stderr.trim() ? `: ${output.stderr.trim()}` : ""}`,
    });
  const skills: HarnessDoctorSkill[] = (yield* decodeOpenCodeSkills(
    new TextDecoder().decode(output.stdout),
  )).map((skill) => ({
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    path: skill.location,
    warnings: [],
    errors: [],
  }));
  return { skills, warnings: nativeListWarnings(output) };
});

/** Devin's own skill list, with its per-skill diagnostics. */
export const readDevinSkills = Effect.fn("Doctor.readDevinSkills")(function* (
  executable: string,
  cwd: string,
) {
  const output = yield* (yield* SourceProcess).output(executable, ["skills", "list", "--json"], {
    cwd,
    ...NATIVE_LIST_LIMITS,
  });
  if (output.exitCode !== 0)
    return yield* new HarnessDiscoveryFailure({
      message: `devin discovery exited ${output.exitCode}${output.stderr.trim() ? `: ${output.stderr.trim()}` : ""}`,
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

const isOpenCodeV2 = (version: string | undefined) => version?.startsWith("2.") === true;

/** How doctor reads one Harness's own Skill discovery, and what that reading can and cannot show. */
export interface NativeDiscovery {
  readonly coverage: HarnessDoctorCheck["coverage"];
  readonly limitations: (version?: string) => readonly string[];
  readonly read: (
    executable: string,
    cwd: string,
    version?: string,
  ) => Effect.Effect<
    { readonly skills: readonly HarnessDoctorSkill[]; readonly warnings: readonly string[] },
    unknown,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | SourceProcess
  >;
  /** Drop diagnostics that only restate SKIT's own expected installed skills. */
  readonly classifyWarnings?: (
    check: HarnessDoctorCheck,
    state: LibraryState,
  ) => HarnessDoctorCheck;
}

/** Codex has its own, richer check. */
export const nativeDiscovery: Record<NativeDoctorHarness, NativeDiscovery> = {
  "claude-code": {
    coverage: "callable-commands",
    limitations: () => [
      "Callable commands only; may include legacy commands and bundled commands. Non-user-invocable skills and file paths are not exposed. Hooks and MCP startup are disabled.",
    ],
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
    limitations: (version?: string) =>
      isOpenCodeV2(version)
        ? [
            "Registered skills after discovery plugin activation and three stable metadata snapshots. Duplicate filesystem IDs are resolved by native precedence without warnings; equal display names can coexist. Skill bodies are omitted.",
          ]
        : [
            "Resolved skills only: duplicate names can replace earlier entries. Native warnings may reveal collisions; the final list cannot prove their absence. Skill bodies are omitted.",
          ],
    read: (executable: string, cwd: string, version?: string) =>
      isOpenCodeV2(version)
        ? readOpenCodeV2Skills(executable, cwd)
        : readOpenCodeSkills(executable, cwd),
    classifyWarnings: classifyOpenCodeWarnings,
  },
  devin: {
    coverage: "native-skills",
    limitations: () => [
      "Native list semantics; completeness across duplicate paths has not been established.",
    ],
    read: (executable: string, cwd: string) => readDevinSkills(executable, cwd),
  },
};

export const doctorHarnessCheck = Effect.fn("Doctor.harness")(function* (
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
    limitations: discovery.limitations(),
    skills: [],
    warnings: [],
  };
  if (overrides?.some(Boolean))
    return {
      ...empty,
      status: "skipped" as const,
      detail:
        "Custom skills directories do not describe the harness's native discovery. Run doctor without root overrides.",
    };
  const probe = yield* probeHarness(harness);
  const version = probe.version ? { version: probe.version } : {};
  if (probe.status !== "installed" || !probe.executablePath)
    return {
      ...empty,
      ...version,
      status: probe.status === "missing" ? ("missing" as const) : ("failed" as const),
      detail: probe.error ?? "Harness unavailable",
    };
  const native = {
    ...empty,
    ...version,
    limitations: discovery.limitations(probe.version ?? undefined),
  };
  return yield* discovery.read(probe.executablePath, cwd, probe.version ?? undefined).pipe(
    Effect.map((result) => ({ ...native, ...result, status: "checked" as const })),
    Effect.catch((error) =>
      Effect.succeed({ ...native, status: "failed" as const, detail: String(error) }),
    ),
  );
});

/** Remove only proven, expected shared/Claude collisions from the diagnostic warnings. */
export function classifyOpenCodeWarnings(
  check: HarnessDoctorCheck,
  state: LibraryState,
): HarnessDoctorCheck {
  if (check.status !== "checked") return check;
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
    if (!agents || agents.current_hash !== agents.expected_hash) continue;
    const claude = state.installed_skills.find(
      (installedSkill) =>
        installedSkill.destination === "claude" &&
        installedSkill.status === "installed" &&
        installedSkill.skill_id === agents.skill_id &&
        installedSkill.skill_version_id === agents.skill_version_id &&
        // Targets render the same retained Version with different native invocation fields.
        // Each copy must match its own recorded rendering, not the other target's bytes.
        installedSkill.current_hash === installedSkill.expected_hash &&
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
  return {
    ...check,
    warnings: collisions
      .filter((collision) => !collision.name || !expected.has(collision.name))
      .map(({ line }) => line),
  };
}

/** Diagnose native discovery against one already-refreshed Library observation. Does not acquire the writer. */
export const inspectNativeDiscovery = Effect.fn("Doctor.inspectNativeDiscovery")(function* (
  inventory: LibraryState,
  options: InventoryRootOptions & { readonly cwd: string },
) {
  const { cwd } = options;
  const { codex, claude, harnesses } = yield* Effect.all(
    {
      codex: doctorCodexCheck(inventory, cwd, options.overrides.codex?.[0], options),
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
        detail: "detail" in codex ? codex.detail : "Native discovery unavailable",
      },
      claude.budget,
    ],
    harnesses: harnesses.map((check) => {
      const located = {
        ...check,
        locations: locations.filter((location) => location.harness === check.harness),
        warnings: [
          ...check.warnings,
          ...aliasErrors.map(
            (error) => `Could not inspect skill aliases at ${error.path}: ${error.message}`,
          ),
        ],
      };
      return nativeDiscovery[check.harness].classifyWarnings?.(located, inventory) ?? located;
    }),
  };
});
