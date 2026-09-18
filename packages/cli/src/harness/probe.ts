import { Effect, FileSystem, Schema } from "effect";
import { captureBounded } from "./probe-process.js";
import { delimiter, join } from "node:path";
// Probing is one Effect workflow. The PATH search and the `--version` subprocess are real I/O and
// belong to the caller's fiber, so an interrupted probe kills the child. The TUI composes
// `probeHarnessEffect` on its own host runtime; the command table, install-method
// classification, version parsing and result shape are shared and pure.
import { LinkStat, type HarnessName } from "@smolai/skit-core";
import { Result } from "effect";
import { harnessFromAlias } from "./catalog.js";
import { UnknownHarness } from "./failures.js";

export type ProbeableHarness = Extract<HarnessName, "codex" | "claude-code" | "opencode" | "devin">;

export const HarnessProbeResult = Schema.Struct({
  harnessId: Schema.Literals(["codex", "claude-code", "opencode", "devin"]),
  status: Schema.Literals(["installed", "missing", "failed"]),
  command: Schema.String,
  executablePath: Schema.NullOr(Schema.String),
  resolvedPath: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  versionOutput: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type HarnessProbeResult = typeof HarnessProbeResult.Type;

export const HarnessProbeReport = Schema.Struct({ probes: Schema.Array(HarnessProbeResult) });
export type HarnessProbeReport = typeof HarnessProbeReport.Type;

export interface HarnessProbeOptions {
  path?: string;
}

const commands: Record<ProbeableHarness, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
  devin: "devin",
};

function versionFrom(output: string): string | null {
  return output.match(/\bv?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;
}

/** The PATH entry, resolved target and version output a probe observes. */
function probeResult(
  harnessId: ProbeableHarness,
  command: string,
  observed: {
    executablePath: string;
    resolvedPath: string;
    versionOutput: string;
    error: string | null;
  } | null,
): HarnessProbeResult {
  if (!observed)
    return {
      harnessId,
      status: "missing",
      command,
      executablePath: null,
      resolvedPath: null,
      version: null,
      versionOutput: null,
      error: `Executable not found on PATH: ${command}`,
    };
  return {
    harnessId,
    status: observed.error ? "failed" : "installed",
    command,
    executablePath: observed.executablePath,
    resolvedPath: observed.resolvedPath,
    version: versionFrom(observed.versionOutput),
    versionOutput: observed.versionOutput || null,
    error: observed.error,
  };
}

const executableOnPath = Effect.fn("Probe.executableOnPath")(function* (
  command: string,
  pathValue: string,
) {
  const linkStat = yield* LinkStat;
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    // Continue searching PATH when the candidate is not executable.
    if (yield* linkStat.identity.executable(candidate)) return candidate;
  }
  return null;
});

/** One Harness probe, owned by the caller's fiber: an interrupt kills the child. */
export const probeHarnessEffect = Effect.fn("Probe.harness")(function* (
  harnessId: ProbeableHarness,
  options: HarnessProbeOptions = {},
) {
  const command = commands[harnessId];
  const executablePath = yield* executableOnPath(command, options.path ?? process.env.PATH ?? "");
  if (!executablePath) return probeResult(harnessId, command, null);
  const fs = yield* FileSystem.FileSystem;
  // The PATH entry is still useful evidence when its target cannot be resolved.
  const resolvedPath = yield* fs
    .realPath(executablePath)
    .pipe(Effect.orElseSucceed(() => executablePath));
  // The same budget spawnSync enforced with maxBuffer, and the same timeout.
  const attempt = yield* Effect.result(
    captureBounded(executablePath, ["--version"], {
      limit: 1_000_000,
      timeoutMs: 5_000,
      includeStderr: true,
    }),
  );
  return probeResult(harnessId, command, {
    executablePath,
    resolvedPath,
    versionOutput: Result.isSuccess(attempt) ? attempt.success.output.trim() : "",
    error: Result.isSuccess(attempt)
      ? attempt.success.exitCode === 0
        ? null
        : `exit ${attempt.success.exitCode}`
      : attempt.failure.message,
  });
});

export const probeHarnessesEffect = Effect.fn("Probe.harnesses")(function* (
  harnessIds: readonly ProbeableHarness[] = ["codex", "claude-code", "opencode", "devin"],
  options: HarnessProbeOptions = {},
) {
  const results: HarnessProbeResult[] = [];
  for (const harness of harnessIds) results.push(yield* probeHarnessEffect(harness, options));
  return results;
});

/** Resolve a user-facing Harness alias, then run the shared probe workflow. */
export const probeRequestedHarnessesEffect = Effect.fn("Probe.requestedHarnesses")(function* (
  subject?: string,
  options: HarnessProbeOptions = {},
) {
  const requested = subject ? harnessFromAlias(subject) : undefined;
  if (subject && !requested) return yield* new UnknownHarness({ value: subject });
  return yield* probeHarnessesEffect(requested ? [requested] : undefined, options);
});
