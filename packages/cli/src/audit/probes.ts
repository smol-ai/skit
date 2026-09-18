// Probes are declared subprocesses, so they belong to the command's fiber and an interrupted audit
// kills the child. The allowlist is checked before spawning, and a probe that refuses, exceeds its
// budget or answers with something other than JSON is a failed probe rather than a failed audit.
import { Effect, Result } from "effect";
import { captureBounded } from "../harness/probe-process.js";
import { arrayAt, isJsonObject } from "@smolai/skit-core";

export interface ProbeOptions {
  probes?: readonly string[];
  allowedSubprocesses?: readonly string[];
}

export interface ProbeResult {
  harness: string;
  status: "ok" | "failed";
  observed?: { plugins?: number; mcpServers?: number };
  reason?: string;
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (!isJsonObject(value)) return 0;
  for (const key of ["installed", "plugins", "servers", "mcpServers", "items"])
    if (Array.isArray(value[key])) return arrayAt(value, key).length;
  return Object.keys(value).length;
}

/** The declared invocations each probe makes, in order. */
const invocations: Record<string, Array<{ key: "plugins" | "mcpServers"; args: string[] }>> = {
  claude: [{ key: "plugins", args: ["claude", "plugin", "list", "--json"] }],
  codex: [
    { key: "plugins", args: ["codex", "plugin", "list", "--json"] },
    { key: "mcpServers", args: ["codex", "mcp", "list", "--json"] },
  ],
};

export const runAuditProbesEffect = Effect.fn("Audit.probes")(function* (options: ProbeOptions) {
  const allowed = new Set(options.allowedSubprocesses ?? []);
  const run = Effect.fn("Audit.probe")(function* (args: string[]) {
    const invocation = args.join(" ");
    // The allowlist is the boundary: an undeclared invocation is refused before spawning.
    if (!allowed.has(invocation))
      return yield* Effect.fail(new Error(`Probe is not declared: ${invocation}`));
    // The same budget spawnSync enforced with maxBuffer, and the same timeout.
    const captured = yield* captureBounded(args[0], args.slice(1), {
      limit: 5_000_000,
      timeoutMs: 10_000,
    });
    if (captured.exitCode !== 0) return yield* Effect.fail(new Error(`exit ${captured.exitCode}`));
    // Malformed output is a failed probe, as it was before, not a defect.
    return yield* Effect.try({
      try: (): unknown => JSON.parse(captured.output),
      catch: () => new Error(`${invocation} did not return JSON`),
    });
  });
  const results: ProbeResult[] = [];
  for (const harness of options.probes ?? []) {
    const steps = invocations[harness];
    if (!steps) {
      results.push({ harness, status: "failed", reason: "unsupported probe" });
      continue;
    }
    const observed: { plugins?: number; mcpServers?: number } = {};
    const attempt = yield* Effect.result(
      Effect.gen(function* () {
        for (const step of steps) observed[step.key] = count(yield* run(step.args));
      }),
    );
    results.push(
      Result.isSuccess(attempt)
        ? { harness, status: "ok", observed }
        : {
            harness,
            status: "failed",
            reason: attempt.failure.message,
          },
    );
  }
  return results;
});
