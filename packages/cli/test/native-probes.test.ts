// The two command paths that now spawn on the caller's fiber.
//
// `skit audit --probe` and `skit harness probe` used to run spawnSync inside a synchronous
// observation, so an interrupted command left the child to finish. These cover what changed:
// the subprocess belongs to the operation, the declared-invocation allowlist still gates it, and
// the TUI composes the same Effect workflows on its own host runtime.

import { join } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { Deferred, Effect, Fiber, FileSystem, Schedule } from "effect";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { runAuditProbesEffect } from "../src/audit/probes.js";
import { probeHarnessEffect } from "../src/harness/probe.js";
import { captureBounded } from "../src/harness/probe-process.js";
import { scratch } from "./helpers/library-home.js";

/** A disposable executable at `<directory>/<name>` with the given shell body. */
const executable = Effect.fn("Test.executable")(function* (name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* scratch("skit-native-probe-");
  const path = join(directory, name);
  yield* fs.writeFileString(path, `#!/bin/sh\n${body}`);
  yield* fs.chmod(path, 0o755);
  return { directory, path };
});

/** A disposable executable that never exits, so only cancellation ends it. */
const neverExits = Effect.fn("Test.neverExits")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* scratch("skit-native-probe-");
  const path = join(directory, name);
  const ready = join(directory, "started");
  yield* fs.writeFileString(path, `#!/bin/sh\ntouch '${ready}'\nwhile true; do sleep 1; done\n`);
  yield* fs.chmod(path, 0o755);
  return { directory, path, ready };
});

/** Run `effect` with `directory` first on PATH, restoring PATH afterwards. */
const onPath = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = process.env.PATH;
      process.env.PATH = `${directory}:${original ?? ""}`;
      return original;
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        process.env.PATH = original;
      }),
  );

// Polls a real file the child writes, so this runs on the live clock rather than the TestClock.
it.live("an interrupted harness probe kills the version subprocess", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { directory, ready } = yield* neverExits("codex");
    const gated = yield* Deferred.make<void>();

    const fiber = yield* Effect.forkScoped(
      probeHarnessEffect("codex", { path: directory }).pipe(
        Effect.onExit(() => Deferred.succeed(gated, undefined)),
      ),
    );
    yield* fs
      .exists(ready)
      .pipe(Effect.repeat({ until: (started) => started, schedule: Schedule.spaced("1 millis") }));
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(gated);

    // The probe belongs to the fiber: interrupting the command ends the child rather than waiting
    // for a version banner that never arrives.
    const exit = yield* Effect.exit(Fiber.join(fiber));
    expect(exit._tag).toBe("Failure");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an audit probe refuses an invocation the command never declared", () =>
  Effect.gen(function* () {
    const results = yield* runAuditProbesEffect({ probes: ["claude"], allowedSubprocesses: [] });

    // The allowlist is checked before spawning, so an undeclared probe never runs.
    expect(results).toEqual([
      {
        harness: "claude",
        status: "failed",
        reason: "Probe is not declared: claude plugin list --json",
      },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an audit probe reports an unsupported harness without spawning", () =>
  Effect.gen(function* () {
    const results = yield* runAuditProbesEffect({ probes: ["opencode"], allowedSubprocesses: [] });

    expect(results).toEqual([
      { harness: "opencode", status: "failed", reason: "unsupported probe" },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a harness probe fails an executable whose output exceeds its budget", () =>
  Effect.gen(function* () {
    // 2 MiB, comfortably over the harness probe's 1,000,000-byte budget.
    const { directory } = yield* executable("codex", "head -c 2097152 /dev/zero | tr '\\0' 'x'\n");

    const probe = yield* probeHarnessEffect("codex", { path: directory });

    // spawnSync bounded this with maxBuffer; the budget is now counted while the pipe drains, and
    // the Scope kills the child rather than letting it keep writing.
    expect(probe).toMatchObject({
      harnessId: "codex",
      status: "failed",
      version: null,
      error: expect.stringContaining("more than 1000000 bytes"),
    });
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("the audit probe budget stops a flood at five million bytes", () =>
  Effect.gen(function* () {
    // 6 MiB, over the audit probe's 5,000,000-byte budget.
    const { path } = yield* executable("flood", "head -c 6291456 /dev/zero | tr '\\0' 'x'\n");

    const failure = yield* captureBounded(path, [], { limit: 5_000_000, timeoutMs: 10_000 }).pipe(
      Effect.flip,
    );

    // Counted while the pipe drains, not collected and then truncated; the Scope kills the child.
    expect(String(failure)).toContain("more than 5000000 bytes");
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an audit probe counts installed plugins and MCP servers from real output", () =>
  Effect.gen(function* () {
    const { directory } = yield* executable(
      "codex",
      `if [ "$1" = "plugin" ]; then printf '%s' '{"installed":[{},{},{}],"available":[{}]}'; else printf '%s' '[{},{}]'; fi\n`,
    );
    const results = yield* onPath(
      directory,
      runAuditProbesEffect({
        probes: ["codex"],
        allowedSubprocesses: ["codex plugin list --json", "codex mcp list --json"],
      }),
    );

    // The counting rule is unchanged: `installed` wins over `available`, and a bare array counts
    // its entries. This moved off spawnSync without changing what it reports.
    expect(results).toEqual([
      { harness: "codex", status: "ok", observed: { plugins: 3, mcpServers: 2 } },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("an audit probe reports malformed output as a failed probe, not a defect", () =>
  Effect.gen(function* () {
    const { directory } = yield* executable("codex", "printf '%s' 'not json'\n");
    const results = yield* onPath(
      directory,
      runAuditProbesEffect({
        probes: ["codex"],
        allowedSubprocesses: ["codex plugin list --json", "codex mcp list --json"],
      }),
    );

    // Parsing is an expected failure: the probe reports itself failed rather than dying.
    expect(results).toEqual([
      {
        harness: "codex",
        status: "failed",
        reason: "codex plugin list --json did not return JSON",
      },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("a noisy child's stderr is drained, so stdout is still read to completion", () =>
  Effect.gen(function* () {
    // Enough stderr to fill a pipe buffer before stdout is written: an undrained stderr would
    // block this child until the timeout instead of answering.
    const { directory } = yield* executable(
      "codex",
      `head -c 400000 /dev/zero | tr '\\0' 'e' >&2\nif [ "$1" = "plugin" ]; then printf '%s' '{"installed":[{}]}'; else printf '%s' '[]'; fi\n`,
    );
    const results = yield* onPath(
      directory,
      runAuditProbesEffect({
        probes: ["codex"],
        allowedSubprocesses: ["codex plugin list --json", "codex mcp list --json"],
      }),
    );

    // Stdout parsed cleanly, and stderr never reached the JSON.
    expect(results).toEqual([
      { harness: "codex", status: "ok", observed: { plugins: 1, mcpServers: 0 } },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);
