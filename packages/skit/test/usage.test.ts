import { it } from "@effect/vitest";
import { expect, test } from "vitest";
import { Clock, Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import { join } from "node:path";
import { SkillUsage, skillUsageLayer, skitLayer } from "../src/index.js";
import { extractUsage } from "../src/usage/events.js";
import { literalCommands, shellReadPaths } from "../src/usage/literals.js";
import { systemError } from "effect/PlatformError";
import { MAX_USAGE_LINE_BYTES } from "../src/usage/scanner.js";

const start = "2026-10-01T00:00:00.000Z",
  end = "2026-10-08T00:00:00.000Z";
const call = (timestamp: string | undefined, id: string) => ({
  type: "assistant",
  timestamp,
  cwd: "/synthetic/project",
  message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill: "example" } }] },
});

test("native events distinguish calls, loads, inventories, slash commands and summaries", () => {
  expect(extractUsage("claude-code", call(start, "one")).events).toEqual([
    { kind: "calls", name: "example", id: "one" },
  ]);
  const load = {
    type: "user",
    isMeta: true,
    uuid: "load",
    message: { content: "Base directory for this skill: /synthetic/skills/example\nInstructions" },
  };
  expect(extractUsage("claude-code", load).events[0]).toMatchObject({
    kind: "loads",
    path: "/synthetic/skills/example/SKILL.md",
  });
  expect(extractUsage("claude-code", { ...load, isMeta: false }).events).toEqual([]);
  expect(extractUsage("claude-code", { ...load, isCompactSummary: true }).events).toEqual([]);
  expect(
    extractUsage("claude-code", {
      type: "user",
      message: {
        content: "<command-message>example</command-message><command-name>/example</command-name>",
      },
    }).slashCommands,
  ).toBe(1);
  const text =
    "<skill>\n<name>example</name>\n<path>/synthetic/skills/example/SKILL.md</path>\nInstructions\n</skill>";
  const payload = {
    type: "message",
    role: "user",
    id: "injection",
    content: [{ type: "input_text", text }],
  };
  expect(extractUsage("codex", { type: "response_item", payload }).events).toHaveLength(1);
  expect(
    extractUsage("codex", { type: "response_item", payload: { ...payload, role: "developer" } })
      .events,
  ).toEqual([]);
  expect(
    extractUsage("codex", {
      type: "response_item",
      payload: { ...payload, content: [{ type: "input_text", text: "Available skills: " + text }] },
    }).events,
  ).toEqual([]);
  expect(extractUsage("codex", { type: "compacted", payload }).events).toEqual([]);
});

test("bounded static command parsing ignores comments and string bodies, accepts literals and fails closed", () => {
  const code = `// tools.exec_command({cmd:"cat /fake/SKILL.md"})
const command='cat /synthetic/skills/example/SKILL.md';
text('tools.exec_command({cmd:"cat /fake/SKILL.md"})');
await tools.exec_command({yield_time_ms:1000, cmd:command, cwd:'/synthetic'});`;
  expect(literalCommands(code)).toEqual({
    commands: [{ cmd: "cat /synthetic/skills/example/SKILL.md", cwd: "/synthetic" }],
    unsupported: false,
  });
  expect(literalCommands("await tools.exec_command({cmd: dynamic})")).toEqual({
    commands: [],
    unsupported: true,
  });
  expect(literalCommands('await tools.exec_command({cmd:"cat /fake/SKILL.md"').commands).toEqual(
    [],
  );
  expect(
    literalCommands('await tools.exec_command({cmd:"cat /fake/SKILL.md",cmd:"echo x"})').commands,
  ).toEqual([]);
  expect(literalCommands("const r=/tools.exec_command/;").commands).toEqual([]);
  expect(literalCommands('if (false) { tools.exec_command({cmd:"cat /fake/SKILL.md"}) }')).toEqual({
    commands: [],
    unsupported: true,
  });
  expect(
    literalCommands(
      'const command="cat /outer/SKILL.md"; {const command="cat /inner/SKILL.md";} tools.exec_command({cmd:command});',
    ).commands,
  ).toEqual([{ cmd: "cat /outer/SKILL.md" }]);
  expect(
    shellReadPaths(
      'cat "/synthetic/skills/example/SKILL.md" && head -n 3 /synthetic/other/SKILL.md',
    ),
  ).toEqual(["/synthetic/skills/example/SKILL.md", "/synthetic/other/SKILL.md"]);
  for (const command of [
    "echo /fake/SKILL.md",
    "rg SKILL.md /fake",
    "cat /fake/SKILL.md > output",
    "cat /fake/SKILL.md.backup",
    "sed -i x /fake/SKILL.md",
    "cat $(echo /fake/SKILL.md)",
  ])
    expect(shellReadPaths(command)).toEqual([]);
});

it.effect(
  "streams raw records with exact boundaries, replay suppression, malformed and undated diagnostics",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-" });
      const records = [
        call(start, "one"),
        call(start, "one"),
        call("2026-09-30T23:59:59.999Z", "old"),
        call(end, "end"),
        call(undefined, "undated"),
        call("invalid", "invalid"),
        [],
        { type: "user", timestamp: start, message: { content: "x".repeat(300_000) } },
      ];
      yield* fs.writeFileString(
        join(root, "one.jsonl"),
        records.map((r) => JSON.stringify(r)).join("\n") + '\n{malformed}\n{"unfinished":',
      );
      yield* fs.makeDirectory(join(root, "subagents"));
      yield* fs.writeFileString(
        join(root, "subagents/two.jsonl"),
        JSON.stringify(call(start, "one")),
      );
      const report = yield* (yield* SkillUsage).scan({
        roots: [{ root, harness: "claude-code" }],
        end,
      });
      expect(report.rows).toMatchObject([
        {
          name: "example",
          calls: 1,
          loads: 0,
          reads: 0,
          identity: "name-only",
          lastObservedAt: start,
        },
      ]);
      expect(report.coverage[0]).toMatchObject({
        files: 2,
        windowRecords: 4,
        undated: 2,
        undatedCandidates: 2,
        malformed: 3,
        duplicates: 2,
        changedFiles: 0,
      });
      expect(report.coverage[0].bytesRead).toBe(report.coverage[0].bytes);
      expect(report.incomplete).toBe(true);
      expect(yield* fs.readFileString(join(root, "subagents/two.jsonl"))).toBe(
        JSON.stringify(call(start, "one")),
      );
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("path identity joins known projections and keeps same-name documents separate", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-identities-" });
    const sources = join(root, "skills");
    yield* fs.makeDirectory(join(sources, "example"), { recursive: true });
    const document = join(sources, "example/SKILL.md");
    yield* fs.writeFileString(document, "Synthetic");
    const alias = join(root, "alias");
    yield* fs.symlink(join(sources, "example"), alias);
    const read = (id: string, file: string) => ({
      type: "response_item",
      timestamp: start,
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: id,
        arguments: JSON.stringify({ cmd: `cat ${file}` }),
      },
    });
    yield* fs.writeFileString(
      join(root, "events.jsonl"),
      [
        read("original", document),
        read("original", join(alias, "SKILL.md")),
        read("different", join(root, "other/example/SKILL.md")),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "codex" }],
      end,
      projections: [{ path: alias, skillId: "skill-example", name: "Example skill" }],
    });
    expect(report.rows).toHaveLength(2);
    expect(report.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Example skill",
          skillId: "skill-example",
          identity: "managed",
          reads: 1,
          path: yield* fs.realPath(document),
        }),
        expect.objectContaining({ name: "example", identity: "unresolved", reads: 1 }),
      ]),
    );
    expect(report.coverage[0].duplicates).toBe(1);
    const ambiguous = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "codex" }],
      end,
      projections: [
        { path: alias, skillId: "one", name: "One" },
        { path: document, skillId: "two", name: "Two" },
      ],
    });
    const canonicalDocument = yield* fs.realPath(document);
    expect(ambiguous.rows.find((r) => r.path === canonicalDocument)).toMatchObject({
      identity: "ambiguous",
      skillId: null,
    });
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("filters projects from raw cwd, skips oversized records and reports missing roots", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-project-" });
    const project = join(root, "project");
    yield* fs.makeDirectory(project);
    yield* fs.writeFileString(
      join(root, "records.jsonl"),
      [
        { ...call(start, "selected"), cwd: project },
        { ...call(start, "other"), cwd: root },
        {
          timestamp: start,
          type: "user",
          message: { content: "x".repeat(MAX_USAGE_LINE_BYTES + 1) },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [
        { root, harness: "claude-code" },
        { root: join(root, "missing"), harness: "codex" },
      ],
      end,
      project,
    });
    expect(report.rows[0].calls).toBe(1);
    expect(report.project).toBe(yield* fs.realPath(project));
    expect(report.coverage[0].oversizedLines).toBe(1);
    expect(report.coverage[1].status).toBe("missing");
    expect(report.incomplete).toBe(true);
    const error = yield* (yield* SkillUsage).scan({ roots: [], days: 0 }).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidUsageOptions");
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("interrupts the source stream and runs its finalizer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-cancel-" });
    yield* fs.writeFileString(join(root, "records.jsonl"), "{}\n");
    const started = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const stream = Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
      Stream.drain,
      Stream.concat(Stream.never),
      Stream.ensuring(Deferred.succeed(closed, undefined)),
    );
    const fiber = yield* Effect.gen(function* () {
      return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "codex" }], end });
    }).pipe(
      Effect.provide(skillUsageLayer),
      Effect.provideService(FileSystem.FileSystem, { ...fs, stream: () => stream }),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(yield* Deferred.isDone(closed)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("retains healthy evidence when another transcript is unreadable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-partial-" });
    const blocked = join(root, "blocked.jsonl");
    yield* fs.writeFileString(blocked, JSON.stringify(call(start, "blocked")));
    yield* fs.writeFileString(join(root, "healthy.jsonl"), JSON.stringify(call(start, "healthy")));
    const error = systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "stream" });
    const report = yield* Effect.gen(function* () {
      return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "claude-code" }], end });
    }).pipe(
      Effect.provide(skillUsageLayer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stream: (file, options) =>
          file === blocked ? Stream.fail(error) : fs.stream(file, options),
      }),
    );
    expect(report.rows).toMatchObject([{ calls: 1 }]);
    expect(report.coverage[0].unreadableFiles).toBe(1);
    expect(report.incomplete).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("uses Codex turn working directories and resolves project aliases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-turns-" });
    const project = join(root, "project");
    yield* fs.makeDirectory(project);
    const alias = join(root, "project-alias");
    yield* fs.symlink(project, alias);
    const meta = {
      type: "session_meta",
      timestamp: "2026-09-30T00:00:00.000Z",
      payload: { id: "session", cwd: root },
    };
    const turn = { type: "turn_context", timestamp: start, payload: { cwd: alias } };
    const read = {
      type: "response_item",
      timestamp: start,
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "turn-read",
        arguments: JSON.stringify({ cmd: "cat .agents/skills/example/SKILL.md" }),
      },
    };
    yield* fs.writeFileString(
      join(root, "turns.jsonl"),
      [meta, turn, read].map((r) => JSON.stringify(r)).join("\n"),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "codex" }],
      end,
      project,
    });
    expect(report.rows).toMatchObject([
      {
        name: "example",
        reads: 1,
        path: join(yield* fs.realPath(project), ".agents/skills/example/SKILL.md"),
      },
    ]);
    expect(report.coverage[0].windowRecords).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("rejects date underflow as an argument error and accepts the exact date boundary", () =>
  Effect.gen(function* () {
    const usage = yield* SkillUsage;
    const error = yield* usage
      .scan({ roots: [], end: "-271821-04-20T00:00:00.000Z" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("InvalidUsageOptions");
    const report = yield* usage.scan({ roots: [], end: "-271821-04-27T00:00:00.000Z" });
    expect(report.window).toEqual({
      start: "-271821-04-20T00:00:00.000Z",
      end: "-271821-04-27T00:00:00.000Z",
    });
  }).pipe(Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("measures duration with monotonic time while the wall clock moves backwards", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    let wallReads = 0;
    let nanosReads = 0;
    const wallTime = () => Date.parse(end) - wallReads++ * 1000;
    const nanos = () => BigInt(nanosReads++) * 1_250_000_000n;
    const controlled: Clock.Clock = {
      currentTimeMillisUnsafe: wallTime,
      currentTimeMillis: Effect.sync(wallTime),
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: nanos,
      monotonicTimeNanos: Effect.sync(nanos),
      sleep: (duration) => clock.sleep(duration),
    };
    const report = yield* (yield* SkillUsage)
      .scan({ roots: [] })
      .pipe(Effect.provideService(Clock.Clock, controlled));
    expect(report.window).toEqual({ start, end });
    expect(report.durationMs).toBe(1250);
    expect(wallTime()).toBe(Date.parse(end) - 1000);
  }).pipe(Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);
