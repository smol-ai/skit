import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result } from "effect";
import { SourceProcess } from "@smolai/skit-core";
import { join } from "node:path";
import { expect } from "vitest";
import { readClaudeCommands, readNativeSkills } from "../src/workflows/library/doctor-harnesses.js";
import { NativeLibraryFixture, nativeLibraryLayer } from "./helpers/native-library.js";

const processLayer = (stdout: unknown, exitCode = 0, stderr = "") =>
  Layer.succeed(
    SourceProcess,
    SourceProcess.of({
      run: () => Effect.die("Unexpected process.run"),
      output: (_executable, args, options) =>
        Effect.sync(() => {
          expect(options?.cwd).toBe("/project");
          expect(options?.maxOutputBytes).toBe(4_000_000);
          if (args[0] === "-e") {
            expect(args[1]).toContain("spawnSync");
            expect(args[2]).toBe("opencode");
            expect(args[3]).toMatch(/skills.json$/);
          } else expect(args).toEqual(["skills", "list", "--json"]);
          return { stdout: new TextEncoder().encode(JSON.stringify(stdout)), exitCode, stderr };
        }),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("keeps OpenCode resolved metadata and warnings, excluding full skill bodies", () =>
  Effect.gen(function* () {
    const result = yield* readNativeSkills("opencode", "opencode", "/project");
    expect(result.skills).toEqual([
      { name: "review", description: "Review", path: "/skill/SKILL.md", warnings: [], errors: [] },
    ]);
    expect(result.warnings).toEqual(["duplicate skill name: review"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE BODY");
  }).pipe(
    Effect.provide(
      processLayer(
        [
          {
            name: "review",
            description: "Review",
            location: "/skill/SKILL.md",
            content: "PRIVATE BODY",
          },
        ],
        0,
        "duplicate skill name: review",
      ),
    ),
  ),
);

it.effect("preserves Devin triggers, ownership metadata and per-skill diagnostics", () =>
  Effect.gen(function* () {
    const result = yield* readNativeSkills("devin", "devin", "/project");
    expect(result.skills[0]).toEqual({
      name: "review",
      path: "/skill",
      provider: "Devin",
      triggers: ["user", "model"],
      warnings: ["collision"],
      errors: ["invalid reference"],
    });
  }).pipe(
    Effect.provide(
      processLayer([
        {
          name: "review",
          description: null,
          display_name: null,
          base_dir: "/skill",
          provider: "Devin",
          triggers: ["user", "model"],
          warnings: ["collision"],
          errors: ["invalid reference"],
        },
      ]),
    ),
  ),
);

it.effect.each(["nonzero", "malformed"])(
  "reports native %s failure rather than an empty healthy list",
  (kind) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(readNativeSkills("opencode", "opencode", "/project"));
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(
      Effect.provide(processLayer({ invalid: true }, kind === "nonzero" ? 1 : 0, "native failure")),
    ),
);

it.effect(
  "Claude initializes without a user prompt, disables hooks/MCP, and closes the waiting subprocess",
  () =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const executable = join(f.root, "fake-claude");
      yield* fs.writeFileString(
        executable,
        `#!${process.execPath}
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert(args.includes('--no-session-persistence'));
assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks, true);
assert(args.includes('--strict-mcp-config'));
assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config')+1]), {mcpServers:{}});
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 assert.equal(request.type,'control_request');
 assert.equal(request.request.subtype,'initialize');
 console.log(JSON.stringify({type:'system',subtype:'notification'}));
 console.log(JSON.stringify({type:'control_response',response:{request_id:'unrelated',subtype:'success'}}));
 console.log(JSON.stringify({type:'control_response',response:{request_id:request.request_id,subtype:'success',response:{commands:[{name:'review',description:'Review',argumentHint:''}]}}}));
});
`,
      );
      yield* fs.chmod(executable, 0o755);
      expect(yield* readClaudeCommands(executable, f.root)).toEqual([
        { name: "review", description: "Review" },
      ]);
    }).pipe(Effect.provide(nativeLibraryLayer)),
);

it.effect.each(["error", "malformed", "eof"])("reports Claude %s initialization failure", (kind) =>
  Effect.gen(function* () {
    const f = yield* NativeLibraryFixture;
    const fs = yield* FileSystem.FileSystem;
    const executable = join(f.root, "fake-claude");
    const response =
      kind === "error"
        ? { request_id: "skit-doctor", subtype: "error", error: "unsupported initialize" }
        : { request_id: "skit-doctor", subtype: "success", response: { commands: "invalid" } };
    yield* fs.writeFileString(
      executable,
      `#!${process.execPath}
require('node:readline').createInterface({input:process.stdin}).on('line', () => {
 ${kind === "eof" ? "process.exit(0)" : `console.log(${JSON.stringify(JSON.stringify({ type: "control_response", response }))})`};
});
`,
    );
    yield* fs.chmod(executable, 0o755);
    expect(Result.isFailure(yield* Effect.result(readClaudeCommands(executable, f.root)))).toBe(
      true,
    );
  }).pipe(Effect.provide(nativeLibraryLayer)),
);

it.effect("captures large OpenCode responses before its early exit and excludes bodies", () =>
  Effect.gen(function* () {
    const f = yield* NativeLibraryFixture;
    const fs = yield* FileSystem.FileSystem;
    const executable = join(f.root, "fake-opencode");
    yield* fs.writeFileString(
      executable,
      `#!${process.execPath}
process.stdout.write(JSON.stringify([{name:'large',description:'Large',location:'/large/SKILL.md',content:'x'.repeat(256000)}]));
process.exit(0);
`,
    );
    yield* fs.chmod(executable, 0o755);
    const result = yield* readNativeSkills("opencode", executable, f.root);
    expect(result.skills).toEqual([
      { name: "large", description: "Large", path: "/large/SKILL.md", warnings: [], errors: [] },
    ]);
  }).pipe(Effect.provide(nativeLibraryLayer)),
);
