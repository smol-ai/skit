import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Result, Schedule } from "effect";
import { SourceProcess } from "@smolai/skit-core";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  currentLibraryState,
  makeProjectionId,
  makeSkillId,
  makeSkillVersionId,
} from "@smolai/skit-core";
import {
  classifyOpenCodeWarnings,
  type HarnessDoctorCheck,
  readClaudeCommands,
  readNativeSkills,
} from "../src/workflows/library/doctor-harnesses.js";
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

it.live.each([
  "success",
  "wrong-directory",
  "plugin-failure",
  "oversized",
  "malformed",
  "cancelled",
])(
  "OpenCode v2 %s uses authenticated inventory after activation and closes its stdin lease",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* NativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const executable = join(f.root, "fake-opencode-v2");
      const closed = join(f.root, "closed");
      const polling = join(f.root, "polling");
      yield* fs.writeFileString(
        executable,
        `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(process.argv.slice(2), ['serve','--stdio','--hostname','127.0.0.1','--port','0','--log-level','warn','--print-logs']);
assert.equal(process.env.OPENCODE_DISABLE_MODELS_FETCH, '1');
assert.notEqual(process.env.OPENCODE_PASSWORD, '');
let polls = 0;
let inventoryReads = 0;
const server = require('node:http').createServer((req,res) => {
 assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64'));
 if (${JSON.stringify(kind)} === 'plugin-failure') { res.writeHead(500); res.end(); return; }
 const plugins = ['opencode.skill','opencode.config.compatibility','opencode.config.skill'];
 if (req.url === '/api/plugin') { polls++; fs.writeFileSync(${JSON.stringify(polling)}, 'polling'); }
 else { assert(polls >= 2, 'inventory read before plugin activation'); assert.equal(req.url, '/api/skill'); inventoryReads++; }
 const data = req.url === '/api/plugin'
   ? plugins.map(id => ({id,state:{status:polls < 2 || ${JSON.stringify(kind)} === 'cancelled' ? 'loading' : 'active'}}))
   : inventoryReads === 1 && ${JSON.stringify(kind)} === 'success' ? [] : [{id:'review-a',name:'Review',path:'/a/SKILL.md',content:'PRIVATE BODY'}, {id:'review-b',name:'Review',path:'/b/SKILL.md',content:'PRIVATE BODY'}];
 const body = JSON.stringify({location:{directory:${kind === "wrong-directory" ? "'/wrong'" : "process.cwd()"}},data});
 res.end(${JSON.stringify(kind)} === 'oversized' ? 'x'.repeat(4000001) : ${JSON.stringify(kind)} === 'malformed' ? '{invalid' : body);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({url:'http://127.0.0.1:' + server.address().port})));
process.stdin.resume();
process.stdin.on('end', () => { if (${JSON.stringify(kind)} === 'success') assert.equal(inventoryReads, 4); fs.writeFileSync(${JSON.stringify(closed)}, 'closed'); server.close(); });
`,
      );
      yield* fs.chmod(executable, 0o755);
      if (kind === "cancelled") {
        const fiber = yield* readNativeSkills("opencode", executable, f.root, "2.0.20").pipe(
          Effect.forkScoped,
        );
        yield* fs
          .exists(polling)
          .pipe(
            Effect.repeat({ schedule: Schedule.spaced("10 millis"), while: (exists) => !exists }),
            Effect.timeout("3 seconds"),
          );
        yield* Fiber.interrupt(fiber);
        expect(yield* fs.readFileString(closed)).toBe("closed");
        return;
      }
      const result = yield* Effect.result(
        readNativeSkills("opencode", executable, f.root, "2.0.20"),
      );
      if (kind === "success") {
        expect(Result.isSuccess(result), String(result)).toBe(true);
        if (Result.isSuccess(result)) {
          expect(result.success.skills.map((skill) => [skill.id, skill.name])).toEqual([
            ["review-a", "Review"],
            ["review-b", "Review"],
          ]);
          expect(JSON.stringify(result.success)).not.toContain("PRIVATE BODY");
        }
      } else expect(Result.isFailure(result)).toBe(true);
      expect(yield* fs.readFileString(closed)).toBe("closed");
    }).pipe(Effect.provide(nativeLibraryLayer)),
);

const collisionFixture = () => {
  const skillId = makeSkillId();
  const versionId = makeSkillVersionId();
  const digest = `sha256:${"a".repeat(64)}`;
  const state = currentLibraryState({
    collections: [],
    skills: [],
    retained_copies: [],
    acquisitions: [],
    global_bindings: [],
    local_bindings: [],
    unmanaged: [],
    projections: (["agents", "claude"] as const).map((target) => ({
      projection_id: makeProjectionId(),
      skill_id: skillId,
      skill_version_id: versionId,
      target,
      root: `/home/.${target}/skills`,
      path: `/home/.${target}/skills/review`,
      expected_digest: digest,
      observed_digest: digest,
      status: "installed" as const,
      projected_at: "2026-10-01T00:00:00.000Z",
    })),
  });
  const warning =
    "WARN duplicate skill name name=review existing=/home/.claude/skills/review/SKILL.md duplicate=/home/.agents/skills/review/SKILL.md";
  const check = {
    harness: "opencode",
    status: "checked",
    cwd: "/home/project",
    coverage: "resolved-skills",
    limitations: [],
    warnings: [warning],
    skills: [
      { name: "review", path: "/home/.agents/skills/review/SKILL.md", warnings: [], errors: [] },
    ],
  } satisfies HarnessDoctorCheck;
  return { state, check, warning };
};

test("doctor treats matching managed targets with the shared copy selected as healthy", () => {
  const { state, check } = collisionFixture();
  expect(classifyOpenCodeWarnings(check, state).warnings).toEqual([]);
  expect(check.warnings).toHaveLength(1);
});

test.each([
  "different-content",
  "different-version",
  "edited",
  "foreign",
  "claude-selected",
  "third-copy",
  "unknown-warning",
])("doctor keeps OpenCode warnings for %s", (kind) => {
  const { state, check } = collisionFixture();
  const claude = state.projections[1];
  if (!claude) throw new Error("Missing fixture projection");
  if (kind === "different-content") claude.observed_digest = `sha256:${"b".repeat(64)}`;
  if (kind === "different-version")
    state.projections[1] = { ...claude, skill_version_id: makeSkillVersionId() };
  if (kind === "edited") claude.status = "conflicted";
  if (kind === "foreign") state.projections.pop();
  if (kind === "claude-selected")
    check.skills = [
      { name: "review", path: "/home/.claude/skills/review/SKILL.md", warnings: [], errors: [] },
    ];
  if (kind === "third-copy")
    check.warnings.push(
      "WARN duplicate skill name name=review existing=/home/.agents/skills/review/SKILL.md duplicate=/home/.config/opencode/skills/review/SKILL.md",
    );
  if (kind === "unknown-warning") check.warnings.push("unknown native warning name=review");
  expect(classifyOpenCodeWarnings(check, state).warnings).toEqual(check.warnings);
});

test("doctor accepts intact target-specific invocation renderings of the same Version", () => {
  const { state, check } = collisionFixture();
  const claude = state.projections[1];
  if (!claude) throw new Error("Missing fixture projection");
  const claudeDigest = `sha256:${"b".repeat(64)}`;
  state.projections[1] = {
    ...claude,
    expected_digest: claudeDigest,
    observed_digest: claudeDigest,
  };
  expect(classifyOpenCodeWarnings(check, state).warnings).toEqual([]);
});
