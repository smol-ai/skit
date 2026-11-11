import { HarnessDiscoveryFailed } from "../src/harnesses/discovery-failures.js";
import { skitLayer, SourceProcess, skitConfigurationLayer } from "../src/platform/index.js";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Result, Schedule, Schema } from "effect";
import { libraryDoctorReport, type LibraryInventory } from "../src/library/inventory.js";

import { ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/universal-consumer.js";
import {
  classifyOpenCodeWarnings,
  type HarnessDoctorCheck,
  readClaudeCommands,
  nativeDiscovery,
  inspectNativeDiscovery,
  DoctorReport,
} from "../src/library/internal/doctor/harnesses.js";
import { nativeLibraryFixture } from "./helpers/native-library.js";

import { captureDisk } from "./helpers/disk-snapshot.js";

it.effect.each([false, true])(
  "assembles native diagnostics without probes for custom roots (unreadable alias: %s)",
  (unreadable) =>
    Effect.gen(function* () {
      const f = yield* nativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const cwd = join(f.root, "project");
      const globalCopy = join(f.root, "claude", "global-review");
      const projectCopy = join(cwd, ".claude", "skills", "project-review");
      for (const path of [globalCopy, projectCopy]) {
        yield* fs.makeDirectory(path, { recursive: true });
        yield* fs.writeFileString(
          join(path, "SKILL.md"),
          "---\nname: review\ndescription: Review\n---\nReview bytes.\n",
        );
      }
      const loop = join(f.root, "claude", "loop");
      if (unreadable) yield* fs.symlink(loop, loop);
      const inventory: LibraryInventory = { skills: [], unmanaged: [], installed_skills: [] };
      const before = yield* captureDisk([f.root]);
      const report = yield* inspectNativeDiscovery(inventory, {
        cwd,
        home: f.root,
        configHome: join(f.root, "config"),
        overrides: {
          codex: [join(f.root, "codex"), join(f.root, "other-codex")],
          "claude-code": [join(f.root, "claude")],
          opencode: [join(f.root, "opencode")],
          devin: [join(f.root, "devin")],
        },
      }).pipe(
        Effect.provide(
          skitConfigurationLayer(f.home).pipe(
            Layer.provideMerge(
              Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
                spawn: () => Effect.die("Custom-root diagnostics must not spawn a native probe"),
              }),
            ),
          ),
        ),
        Effect.provideService(SourceProcess, {
          run: () => Effect.die("Unexpected native process"),
          output: () => Effect.die("Unexpected native process"),
        }),
      );
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(DoctorReport))({
        ...libraryDoctorReport(inventory),
        ...report,
      });
      yield* Schema.decodeUnknownEffect(DoctorReport)(encoded);
      expect(report.codex.status).toBe("skipped");
      expect(report.codex).toHaveProperty("rootOverrides", [
        join(f.root, "codex"),
        join(f.root, "other-codex"),
      ]);
      expect(report.codex).not.toHaveProperty("protocol");
      expect(report.codex).not.toHaveProperty("detail");
      expect(report.listing_budgets[0]).toMatchObject({
        _tag: "Unavailable",
        harness: "codex",
        cwd,
      });
      expect(report.listing_budgets[0]).toHaveProperty("reason", {
        _tag: "CustomRoot",
        roots: [join(f.root, "codex"), join(f.root, "other-codex")],
      });
      expect(report.listing_budgets[0]).not.toHaveProperty("detail");
      expect(report.listing_budgets[1]).toMatchObject({ harness: "claude-code", cwd });
      for (const check of report.harnesses) {
        expect(check).toHaveProperty("rootOverrides");
        expect(check).not.toHaveProperty("protocol");
        expect(check).not.toHaveProperty("detail");
        expect(check).not.toHaveProperty("limitations");
      }
      expect(report.harnesses.map((check) => [check.harness, check.status, check.cwd])).toEqual([
        ["claude-code", "skipped", cwd],
        ["opencode", "skipped", cwd],
        ["devin", "skipped", cwd],
      ]);
      const claude = report.harnesses.find((check) => check.harness === "claude-code");
      expect(
        claude?.locations
          ?.flatMap((location) => location.aliases.map((alias) => alias.path))
          .sort(),
      ).toEqual([globalCopy, projectCopy].sort());
      for (const check of report.harnesses) {
        expect(check.locations?.every((location) => location.harness === check.harness)).toBe(true);
        expect(
          Boolean(
            check.aliasErrors?.some(
              (error) => error.path === loop && error.reason._tag === "Unreadable",
            ),
          ),
        ).toBe(unreadable);
      }
      expect(yield* captureDisk([f.root])).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

const processLayer = (stdout: unknown, exitCode = 0, stderr = "") =>
  Layer.effect(
    SourceProcess,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return SourceProcess.of({
        run: () => Effect.die("Unexpected process.run"),
        output: (_executable, args, options) =>
          Effect.gen(function* () {
            expect(options?.cwd).toBe("/project");
            expect(options?.maxOutputBytes).toBe(4_000_000);
            if (args[0] === "-e") {
              expect(args[1]).toContain("spawnSync");
              expect(args[2]).toBe("opencode");
              expect(args[3]).toMatch(/skills.json$/);
              const body = JSON.stringify(stdout);
              yield* fs.writeFileString(args[3]!, body);
              return {
                stdout: new TextEncoder().encode(
                  JSON.stringify({ exitCode, signal: null, size: Buffer.byteLength(body) }),
                ),
                exitCode: 0,
                stderr,
              };
            }
            expect(args).toEqual(["skills", "list", "--json"]);
            return { stdout: new TextEncoder().encode(JSON.stringify(stdout)), exitCode, stderr };
          }),
      });
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("keeps OpenCode resolved metadata and warnings, excluding full skill bodies", () =>
  Effect.gen(function* () {
    const result = yield* nativeDiscovery.opencode.read("opencode", "/project");
    expect(nativeDiscovery.opencode.protocol()).toBe("opencode-debug-skill");
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
    const result = yield* nativeDiscovery.devin.read("devin", "/project");
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
      const result = yield* Effect.result(nativeDiscovery.opencode.read("opencode", "/project"));
      expect(Result.isFailure(result)).toBe(true);
    }).pipe(
      Effect.provide(processLayer({ invalid: true }, kind === "nonzero" ? 1 : 0, "native failure")),
    ),
);

it.effect(
  "Claude initializes without a user prompt, disables hooks/MCP, and closes the waiting subprocess",
  () =>
    Effect.gen(function* () {
      const f = yield* nativeLibraryFixture;
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
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect.each(["error", "malformed", "eof"])("reports Claude %s initialization failure", (kind) =>
  Effect.gen(function* () {
    const f = yield* nativeLibraryFixture;
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
    const result = yield* Effect.result(readClaudeCommands(executable, f.root));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && kind !== "malformed") {
      expect(Schema.is(HarnessDiscoveryFailed)(result.failure)).toBe(true);
      if (Schema.is(HarnessDiscoveryFailed)(result.failure))
        expect(result.failure.reason).toEqual(
          kind === "error"
            ? { _tag: "RemoteError", method: "initialize", diagnostic: "unsupported initialize" }
            : { _tag: "ResponseMissing", method: "initialize" },
        );
    }
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("captures large OpenCode responses before its early exit and excludes bodies", () =>
  Effect.gen(function* () {
    const f = yield* nativeLibraryFixture;
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
    const result = yield* nativeDiscovery.opencode.read(executable, f.root);
    expect(result.skills).toEqual([
      { name: "large", description: "Large", path: "/large/SKILL.md", warnings: [], errors: [] },
    ]);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
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
      const f = yield* nativeLibraryFixture;
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
        const fiber = yield* nativeDiscovery.opencode
          .read(executable, f.root, "2.0.20")
          .pipe(Effect.forkScoped);
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
        nativeDiscovery.opencode.read(executable, f.root, "2.0.20"),
      );
      expect(nativeDiscovery.opencode.protocol("2.0.20")).toBe("opencode-http-v2");
      if (kind === "success") {
        expect(Result.isSuccess(result), JSON.stringify(result)).toBe(true);
        if (Result.isSuccess(result)) {
          expect(result.success.skills.map((skill) => [skill.id, skill.name])).toEqual([
            ["review-a", "Review"],
            ["review-b", "Review"],
          ]);
          expect(JSON.stringify(result.success)).not.toContain("PRIVATE BODY");
        }
      } else {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result) && kind !== "malformed") {
          expect(Schema.is(HarnessDiscoveryFailed)(result.failure)).toBe(true);
          if (Schema.is(HarnessDiscoveryFailed)(result.failure)) {
            const reason = result.failure.reason;
            if (kind === "wrong-directory")
              expect(reason).toEqual({
                _tag: "DirectoryMismatch",
                endpoint: "/api/plugin",
                expected: yield* fs.realPath(f.root),
                actual: "/wrong",
              });
            if (kind === "plugin-failure")
              expect(reason).toEqual({ _tag: "HttpStatus", endpoint: "/api/plugin", status: 500 });
            if (kind === "oversized")
              expect(reason).toMatchObject({
                _tag: "OutputLimitExceeded",
                endpoint: "/api/plugin",
                limitBytes: 4_000_000,
                actualBytes: expect.any(Number),
              });
            const encoded = Schema.encodeSync(Schema.toCodecJson(HarnessDiscoveryFailed))(
              result.failure,
            );
            const decoded = Schema.decodeUnknownSync(HarnessDiscoveryFailed)(
              JSON.parse(JSON.stringify(encoded)),
            );
            expect(decoded.reason).toEqual(reason);
            expect(encoded).not.toHaveProperty("message");
          }
        }
      }
      expect(yield* fs.readFileString(closed)).toBe("closed");
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

const collisionFixture = () => {
  const skillId = makeSkillId();
  const versionId = makeSkillVersionId();
  const hash = `sha256:${"a".repeat(64)}`;
  const state: LibraryInventory = {
    skills: [],
    unmanaged: [],
    installed_skills: (["agents", "claude"] as const).map((target) => ({
      installed_skill_id: makeInstalledSkillId(),
      skill_id: skillId,
      skill_version_id: versionId,
      destination: target,
      root: `/home/.${target}/skills`,
      path: `/home/.${target}/skills/review`,
      expected_hash: hash,
      current_hash: hash,
      status: "installed" as const,
      installed_at: "2026-10-01T00:00:00.000Z",
    })),
  };
  const warning =
    "WARN duplicate skill name name=review existing=/home/.claude/skills/review/SKILL.md duplicate=/home/.agents/skills/review/SKILL.md";
  const check = {
    harness: "opencode",
    status: "checked",
    cwd: "/home/project",
    coverage: "resolved-skills",
    warnings: [warning],
    findings: [],
    skills: [
      { name: "review", path: "/home/.agents/skills/review/SKILL.md", warnings: [], errors: [] },
    ],
  } satisfies HarnessDoctorCheck;
  return { state, check, warning };
};

test("doctor treats matching managed targets with the shared copy selected as healthy", () => {
  const { state, check } = collisionFixture();
  expect(classifyOpenCodeWarnings(check, state).warnings).toEqual([]);
  expect(classifyOpenCodeWarnings(check, state).findings).toEqual([]);
  expect(check.warnings).toHaveLength(1);
});

test.each([
  "different-version",
  "edited",
  "foreign",
  "claude-selected",
  "third-copy",
  "unknown-warning",
])("doctor keeps OpenCode warnings for %s", (kind) => {
  const { state, check } = collisionFixture();
  const claude = state.installed_skills[1];
  if (!claude) throw new Error("Missing fixture installed skill");
  if (kind === "edited")
    state.installed_skills[1] = {
      ...claude,
      status: "conflicted",
      conflicts: [
        {
          _tag: "ContentChanged",
          baseline: "marker",
          expected: claude.expected_hash,
          actual: `sha256:${"b".repeat(64)}`,
        },
      ],
      current_hash: `sha256:${"b".repeat(64)}`,
    };
  if (kind === "different-version")
    state.installed_skills[1] = { ...claude, skill_version_id: makeSkillVersionId() };
  if (kind === "foreign") state.installed_skills.pop();
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
  const claude = state.installed_skills[1];
  if (!claude) throw new Error("Missing fixture installed skill");
  const claudeHash = `sha256:${"b".repeat(64)}`;
  state.installed_skills[1] = {
    ...claude,
    expected_hash: claudeHash,
  };
  expect(classifyOpenCodeWarnings(check, state).warnings).toEqual([]);
  expect(classifyOpenCodeWarnings(check, state).findings).toEqual([]);
});

test("doctor exposes deduplicated collision facts, selected copy and unclassified native warnings", () => {
  const { check } = collisionFixture();
  const first = "/home/Project skills/review/SKILL.md";
  const second = '/home/A "quoted" folder/review/SKILL.md';
  check.skills = [{ name: "review guide", path: second, warnings: [], errors: [] }];
  const collision = `WARN duplicate skill name name="review guide" existing=${JSON.stringify(first)} duplicate=${JSON.stringify(second)}`;
  const unknown = "unknown native warning name=review";
  const malformed = "WARN duplicate skill name name=review existing=/missing-duplicate";
  check.warnings = [collision, `${collision}\n${unknown}`, malformed];
  const result = classifyOpenCodeWarnings(check, {
    skills: [],
    unmanaged: [],
    installed_skills: [],
  });
  expect(result.warnings).toEqual([collision, collision, unknown, malformed]);
  expect(result.findings).toEqual([
    {
      _tag: "NameCollision",
      name: "review guide",
      paths: [second, first].sort(),
      selectedPath: second,
    },
    { _tag: "Warning", message: unknown },
    { _tag: "Warning", message: malformed },
  ]);
  expect(check.warnings).toEqual([collision, `${collision}\n${unknown}`, malformed]);
});

it.effect.each(["exit", "oversized"])("OpenCode capture retains native %s facts", (kind) =>
  Effect.gen(function* () {
    const f = yield* nativeLibraryFixture;
    const fs = yield* FileSystem.FileSystem;
    const executable = join(f.root, "fake-opencode");
    yield* fs.writeFileString(
      executable,
      `#!${process.execPath}\n${kind === "exit" ? "process.stderr.write('native diagnostic');process.exit(7);" : "require('node:fs').writeSync(1, 'x'.repeat(4000001));"}`,
    );
    yield* fs.chmod(executable, 0o755);
    const result = yield* Effect.result(nativeDiscovery.opencode.read(executable, f.root));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(HarnessDiscoveryFailed)(result.failure)).toBe(true);
      if (Schema.is(HarnessDiscoveryFailed)(result.failure))
        expect(result.failure.reason).toEqual(
          kind === "exit"
            ? {
                _tag: "ExitCode",
                command: executable,
                arguments: ["debug", "skill", "--print-logs", "--log-level", "WARN"],
                exitCode: 7,
                stderr: "native diagnostic",
              }
            : {
                _tag: "OutputLimitExceeded",
                phase: "inventory",
                limitBytes: 4_000_000,
                actualBytes: 4_000_001,
              },
        );
    }
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
