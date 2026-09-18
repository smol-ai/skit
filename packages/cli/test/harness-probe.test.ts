import { join } from "node:path";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { skitLayer } from "@smolai/skit-core";
import { probeHarnessEffect } from "../src/harness/probe.js";

describe("harness probe", () => {
  it.effect("reports executable, resolved target, and parsed product version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-harness-probe-" });
      const target = join(root, "claude-target");
      const executable = join(root, "claude");
      // A real executable now, since the probe spawns rather than taking an injected result.
      yield* fs.writeFileString(target, "#!/bin/sh\nprintf '%s' '2.1.251 (Claude Code)'\n");
      yield* fs.chmod(target, 0o755);
      yield* fs.symlink(target, executable);

      const result = yield* probeHarnessEffect("claude-code", { path: root });

      expect(result).toEqual(
        expect.objectContaining({
          harnessId: "claude-code",
          status: "installed",
          executablePath: executable,
          resolvedPath: yield* fs.realPath(target),
          version: "2.1.251",
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports a missing executable without spawning it", () =>
    Effect.gen(function* () {
      const result = yield* probeHarnessEffect("codex", { path: "" });
      expect(result).toEqual(
        expect.objectContaining({ status: "missing", executablePath: null, version: null }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("probes Devin and parses its version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-devin-probe-" });
      const release = join(root, ".local", "share", "devin", "cli", "_versions", "1.2.3", "bin");
      const target = join(release, "devin");
      const executable = join(root, "devin");
      yield* fs.makeDirectory(release, { recursive: true });
      yield* fs.writeFileString(target, "#!/bin/sh\nprintf '%s' 'devin 1.2.3 (abcdef)'\n");
      yield* fs.chmod(target, 0o755);
      yield* fs.symlink(target, executable);

      const result = yield* probeHarnessEffect("devin", { path: root });

      expect(result).toMatchObject({
        harnessId: "devin",
        status: "installed",
        command: "devin",
        executablePath: executable,
        resolvedPath: yield* fs.realPath(target),
        version: "1.2.3",
      });
    }).pipe(Effect.provide(skitLayer)),
  );
});
