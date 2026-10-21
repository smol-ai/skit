import { it } from "@effect/vitest";
import { expect, test } from "vitest";
import { Clock, Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { SkillUsage, skillUsageLayer, skitLayer } from "../src/index.js";
import {
  claudeTranscriptGrammar,
  codexTranscriptGrammar,
  extractUsage,
} from "../src/usage/events.js";
import { literalCommands, shellReadPaths } from "../src/usage/literals.js";
import { systemError } from "effect/PlatformError";

const start = "2026-10-01T00:00:00.000Z",
  end = "2026-10-08T00:00:00.000Z";
const call = (timestamp: string | undefined, id: string) => ({
  type: "assistant",
  timestamp,
  cwd: "/synthetic/project",
  message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill: "example" } }] },
});

test("native events distinguish calls, loads, inventories, slash commands and summaries", () => {
  expect(extractUsage(claudeTranscriptGrammar, call(start, "one")).events).toEqual([
    { kind: "calls", name: "example", id: "one" },
  ]);
  const load = {
    type: "user",
    isMeta: true,
    uuid: "load",
    message: { content: "Base directory for this skill: /synthetic/skills/example\nInstructions" },
  };
  expect(extractUsage(claudeTranscriptGrammar, load).events[0]).toMatchObject({
    kind: "loads",
    path: "/synthetic/skills/example/SKILL.md",
  });
  expect(extractUsage(claudeTranscriptGrammar, { ...load, isMeta: false }).events).toEqual([]);
  expect(extractUsage(claudeTranscriptGrammar, { ...load, isCompactSummary: true }).events).toEqual(
    [],
  );
  expect(
    extractUsage(claudeTranscriptGrammar, {
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
  expect(
    extractUsage(codexTranscriptGrammar, { type: "response_item", payload }).events,
  ).toHaveLength(1);
  expect(
    extractUsage(codexTranscriptGrammar, {
      type: "response_item",
      payload: { ...payload, role: "developer" },
    }).events,
  ).toEqual([]);
  expect(
    extractUsage(codexTranscriptGrammar, {
      type: "response_item",
      payload: { ...payload, content: [{ type: "input_text", text: "Available skills: " + text }] },
    }).events,
  ).toEqual([]);
  expect(extractUsage(codexTranscriptGrammar, { type: "compacted", payload }).events).toEqual([]);
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

it.effect("filters projects from raw cwd, reads large records and reports missing roots", () =>
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
          ...call(start, "large"),
          cwd: project,
          message: {
            content: [
              {
                type: "tool_use",
                id: "large",
                name: "Skill",
                input: { skill: "large", args: "x".repeat(17 * 1024 * 1024) },
              },
            ],
          },
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
    expect(report.rows.find((row) => row.name === "large")).toMatchObject({ calls: 1, uses: 1 });
    expect(report.coverage[0].malformed).toBe(0);
    expect(report.coverage[1].status).toBe("missing");
    expect(report.incomplete).toBe(false);
    const error = yield* (yield* SkillUsage).scan({ roots: [], days: 0 }).pipe(Effect.flip);
    expect(error._tag).toBe("InvalidUsageOptions");
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect.each(["jsonl", "jsonl.zst"])(
  "interrupts the %s source stream and runs its finalizer",
  (extension) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-cancel-" });
      yield* fs.writeFileString(join(root, `records.${extension}`), "{}\n");
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

test("recognizes legacy shell argv and diagnoses unsupported command shapes", () => {
  const record = (command: unknown) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "shell",
      call_id: "legacy-read",
      arguments: JSON.stringify({ command, workdir: "/synthetic/project" }),
    },
  });
  for (const shell of ["bash", "/bin/sh", "/usr/bin/zsh"])
    for (const flag of ["-c", "-lc"]) {
      const result = extractUsage(
        codexTranscriptGrammar,
        record([shell, flag, "cat /synthetic/skills/example/SKILL.md"]),
      );
      expect(result.events).toEqual([
        {
          kind: "reads",
          name: "example",
          path: "/synthetic/skills/example/SKILL.md",
          id: "legacy-read",
          cwd: "/synthetic/project",
        },
      ]);
      expect(result.unsupported).toBe(0);
    }
  for (const command of [
    ["cat", "/synthetic/skills/example/SKILL.md"],
    ["bash", "-lc", 42],
    ["bash", "-lc", "cat /synthetic/skills/example/SKILL.md", "arg"],
    [],
    {},
  ]) {
    const result = extractUsage(codexTranscriptGrammar, record(command));
    expect(result.events).toEqual([]);
    expect(result.unsupported).toBe(1);
  }
});

it.effect(
  "reports a coverage gap for unrecognized shell argv without discarding recognized reads",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-argv-" });
      const record = (id: string, command: unknown) => ({
        timestamp: start,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: id,
          arguments: JSON.stringify({ command }),
        },
      });
      yield* fs.writeFileString(
        join(root, "legacy.jsonl"),
        [
          record("known", ["bash", "-lc", "cat /synthetic/skills/example/SKILL.md"]),
          record("unknown", ["python", "-c", "pass"]),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      );
      const report = yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "codex" }], end });
      expect(report.rows).toMatchObject([{ name: "example", reads: 1 }]);
      expect(report.coverage[0].unsupported).toBe(1);
      expect(report.incomplete).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

test("skill filename mentions and output callbacks do not diagnose unsupported reads", () => {
  const wrap = (input: string) =>
    extractUsage(codexTranscriptGrammar, {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "functions.exec", input, call_id: "example" },
    });
  for (const input of [
    'await tools.apply_patch("*** Add File: /example/SKILL.md");',
    'await tools.web__run({search_query:[{q:"SKILL.md"}]});',
    'text("SKILL.md"); const f = x => x?.name || "unknown";',
  ])
    expect(wrap(input)).toMatchObject({ events: [], unsupported: 0 });
  expect(
    wrap(
      'const r=await tools.exec_command({cmd:"cat /example/SKILL.md"}); text(r.output.split("\\n").map(x=>x.trim()));',
    ),
  ).toMatchObject({
    events: [{ kind: "reads", path: "/example/SKILL.md" }],
    unsupported: 0,
  });
  expect(
    wrap(
      'await tools.exec_command({cmd:"cat /example/SKILL.md"}); if (ready) { await tools.exec_command({cmd:dynamic}); }',
    ),
  ).toMatchObject({
    events: [{ kind: "reads", path: "/example/SKILL.md" }],
    unsupported: 1,
  });
});

test("unknown and hoisted declarations cannot inherit a shadowed command constant", () => {
  for (const declaration of [
    'let cmd="echo nothing"',
    "const cmd=dynamic",
    "const {cmd}=config",
    "class cmd {}",
  ]) {
    const parsed = literalCommands(
      `const cmd="cat /outer/SKILL.md"; { ${declaration}; await tools.exec_command({cmd}); } await tools.exec_command({cmd});`,
    );
    expect(parsed).toEqual({ commands: [{ cmd: "cat /outer/SKILL.md" }], unsupported: true });
  }
  expect(
    literalCommands(
      'const cmd="cat /outer/SKILL.md"; { await tools.exec_command({cmd}); const cmd="echo nothing"; }',
    ),
  ).toEqual({ commands: [], unsupported: true });
  expect(
    literalCommands(
      'const cmd="cat /outer/SKILL.md"; {const cmd="echo nothing"; await tools.exec_command({cmd});} await tools.exec_command({cmd});',
    ),
  ).toEqual({
    commands: [{ cmd: "echo nothing" }, { cmd: "cat /outer/SKILL.md" }],
    unsupported: false,
  });
});

test("shell syntax in adjacent segments does not suppress a literal read or invent nested reads", () => {
  for (const command of [
    'cat /example/SKILL.md; echo "$status"',
    'echo "$status"; cat /example/SKILL.md',
    "cat /example/SKILL.md; echo $(cat /fake/SKILL.md; echo nested)",
    "echo `cat /fake/SKILL.md`; cat /example/SKILL.md",
    "cat /example/SKILL.md; cat /fake/SKILL.md > out",
    "cat /example/SKILL.md # cat /fake/SKILL.md",
    "cat /example/SKILL.md; function f() { cat /fake/SKILL.md; }",
  ])
    expect(shellReadPaths(command)).toEqual(["/example/SKILL.md"]);
  for (const command of [
    "cat $(echo /fake/SKILL.md)",
    'cat "$(echo x; cat /fake/SKILL.md)"',
    "cat <<EOF\ncat /fake/SKILL.md\nEOF",
    "sed SKILL.md /ordinary.txt",
    "sed -e SKILL.md /ordinary.txt",
  ])
    expect(shellReadPaths(command)).toEqual([]);
  expect(shellReadPaths("sed -n '1,20p' /example/SKILL.md")).toEqual(["/example/SKILL.md"]);
});

it.effect("correlates Claude selections and linked expansions without double counting", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-attribution-" });
    const user = (uuid: string, content: string, extra = {}) => ({
      type: "user",
      uuid,
      timestamp: start,
      sessionId: "claude-session",
      message: { content },
      ...extra,
    });
    const load = (uuid: string, sourceToolUseID?: string) =>
      user(uuid, "Base directory for this skill: /synthetic/skills/example\nInstructions", {
        isMeta: true,
        ...(sourceToolUseID ? { sourceToolUseID } : {}),
      });
    const records = [
      user(
        "slash",
        "<command-name>/plugin:example</command-name>\n            <command-message>plugin:example</command-message>\n<command-args>check this</command-args>",
      ),
      load("explicit-load"),
      user("question", "Do the task"),
      { ...call(start, "proactive"), sessionId: "claude-session" },
      load("implicit-load", "proactive"),
      { ...call(start, "again"), sessionId: "claude-session" },
      user("help", "<command-message>help</command-message><command-name>/help</command-name>"),
      user("next-question", "Another task"),
      load("unknown-load"),
    ];
    yield* fs.writeFileString(
      join(root, "one.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n"),
    );
    // An independently retained copy must not inflate invocation totals.
    yield* fs.writeFileString(
      join(root, "replay.jsonl"),
      records.map((r) => JSON.stringify(r)).join("\n"),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "claude-code" }],
      end,
    });
    expect(report.rows.find((r) => r.path === "/synthetic/skills/example/SKILL.md")).toMatchObject({
      uses: 3,
      explicit: 1,
      implicit: 1,
      unknown: 1,
    });
    expect(report.rows.reduce((n, r) => n + r.uses, 0)).toBe(3);
    expect(report.rows.find((r) => r.name === "help")).toBeUndefined();
    expect(report.rows.every((r) => r.uses === r.explicit + r.implicit + r.unknown)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect(
  "attributes Codex activity per session and turn, preserving unknown document access",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-attribution-" });
      const turn = (id: string) => ({
        type: "turn_context",
        timestamp: start,
        payload: { turn_id: id },
      });
      const read = (id: string, path = "/synthetic/skills/example/SKILL.md") => ({
        type: "response_item",
        timestamp: start,
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: id,
          arguments: JSON.stringify({ cmd: `cat ${path}` }),
        },
      });
      const records = [
        { type: "session_meta", payload: { id: "codex-session" } },
        turn("explicit"),
        {
          type: "response_item",
          timestamp: start,
          payload: {
            type: "message",
            role: "user",
            id: "selected",
            content: [
              {
                type: "input_text",
                text: "<skill>\n<name>example</name>\n<path>/synthetic/skills/example/SKILL.md</path>\nInstructions\n</skill>",
              },
            ],
          },
        },
        read("first"),
        read("second"),
        turn("implicit"),
        read("third"),
        read("fourth"),
        read("document", "/synthetic/reference/SKILL.md"),
        { type: "compacted", timestamp: start },
        read("missing-turn"),
      ];
      yield* fs.writeFileString(
        join(root, "one.jsonl"),
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
      yield* fs.writeFileString(
        join(root, "replay.jsonl"),
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
      // Native IDs can coincide in different sessions.
      yield* fs.writeFileString(
        join(root, "other.jsonl"),
        [
          { type: "session_meta", payload: { id: "other-session" } },
          turn("implicit"),
          read("third"),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n"),
      );
      const report = yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "codex" }], end });
      expect(report.rows.find((r) => r.name === "example")).toMatchObject({
        uses: 4,
        explicit: 1,
        implicit: 2,
        unknown: 1,
      });
      expect(report.rows.find((r) => r.name === "reference")).toMatchObject({
        uses: 1,
        unknown: 1,
      });
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect(
  "keeps ambiguous skill paths separate and correlates native links without turn metadata",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-attribution-" });
      const load = (uuid: string, path: string, sourceToolUseID?: string) => ({
        type: "user",
        timestamp: start,
        uuid,
        sessionId: "session",
        isMeta: true,
        ...(sourceToolUseID ? { sourceToolUseID } : {}),
        message: { content: `Base directory for this skill: ${path}\nInstructions` },
      });
      const records = [
        { ...call(start, "linked"), sessionId: "session" },
        load("linked-load", "/one/skills/example", "linked"),
        {
          type: "user",
          timestamp: start,
          uuid: "prompt",
          sessionId: "session",
          message: { content: "Do it" },
        },
        load("one", "/one/skills/example"),
        load("two", "/two/skills/example"),
        { ...call(start, "ambiguous"), sessionId: "session" },
        // An image-only user message is also a new turn.
        {
          type: "user",
          timestamp: start,
          uuid: "image",
          sessionId: "session",
          message: { content: [{ type: "image", source: {} }] },
        },
        { ...call(start, "after-image"), sessionId: "session" },
      ];
      yield* fs.writeFileString(
        join(root, "one.jsonl"),
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
      const report = yield* (yield* SkillUsage).scan({
        roots: [{ root, harness: "claude-code" }],
        end,
      });
      expect(report.rows.find((r) => r.path === "/one/skills/example/SKILL.md")).toMatchObject({
        uses: 2,
        implicit: 1,
        unknown: 1,
      });
      expect(report.rows.find((r) => r.path === "/two/skills/example/SKILL.md")).toMatchObject({
        uses: 1,
        unknown: 1,
      });
      expect(report.rows.find((r) => r.identity === "name-only")).toMatchObject({
        uses: 2,
        implicit: 2,
      });
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("does not collapse Claude subagents sharing a parent session and prompt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-attribution-" });
    for (const agentId of ["first", "second"]) {
      const records = [
        {
          type: "user",
          timestamp: start,
          uuid: "prompt",
          promptId: "shared-prompt",
          sessionId: "parent",
          agentId,
          message: { content: "Do it" },
        },
        { ...call(start, "shared-native-id"), sessionId: "parent", agentId },
      ];
      yield* fs.writeFileString(
        join(root, `${agentId}.jsonl`),
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
    }
    const report = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "claude-code" }],
      end,
    });
    expect(report.rows).toMatchObject([{ uses: 2, implicit: 2, calls: 2 }]);
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("keeps Claude document access and Codex multi-skill inspection out of usage counts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-inspection-" });
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    yield* fs.makeDirectory(claude);
    yield* fs.makeDirectory(codex);
    const claudeRecords = [
      {
        type: "user",
        timestamp: start,
        uuid: "edit",
        sessionId: "claude",
        message: { content: "Fix typos in these skills" },
      },
      {
        type: "assistant",
        timestamp: start,
        sessionId: "claude",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read",
              name: "Read",
              input: { file_path: "/repo/skills/read/SKILL.md" },
            },
            {
              type: "tool_use",
              id: "bash",
              name: "Bash",
              input: { command: "cat /repo/skills/bash/SKILL.md" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: start,
        uuid: "clear",
        sessionId: "claude",
        message: {
          content: "<command-name>/clear</command-name>\n <command-message>clear</command-message>",
        },
      },
    ];
    const codexRecords = [
      { type: "session_meta", payload: { id: "codex" } },
      { type: "turn_context", timestamp: start, payload: { turn_id: "inspect" } },
      {
        type: "response_item",
        timestamp: start,
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "scan",
          arguments: JSON.stringify({
            cmd: "sed -n 1,5p /repo/skills/first/SKILL.md /repo/skills/second/SKILL.md",
          }),
        },
      },
      {
        type: "response_item",
        timestamp: start,
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "activate",
          arguments: JSON.stringify({ cmd: "cat /repo/skills/single/SKILL.md" }),
        },
      },
    ];
    yield* fs.writeFileString(
      join(claude, "one.jsonl"),
      claudeRecords.map((r) => JSON.stringify(r)).join("\n"),
    );
    yield* fs.writeFileString(
      join(codex, "one.jsonl"),
      codexRecords.map((r) => JSON.stringify(r)).join("\n"),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [
        { root: claude, harness: "claude-code" },
        { root: codex, harness: "codex" },
      ],
      end,
    });
    expect(report.rows.find((r) => r.name === "clear")).toBeUndefined();
    for (const name of ["read", "bash", "first", "second"])
      expect(report.rows.find((r) => r.name === name)).toMatchObject({
        reads: 1,
        uses: 0,
        explicit: 0,
        implicit: 0,
        unknown: 0,
      });
    expect(report.rows.find((r) => r.name === "single")).toMatchObject({
      reads: 1,
      uses: 1,
      implicit: 1,
    });
    expect(report.rows.reduce((n, r) => n + r.uses, 0)).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect(
  "corroborates a namespaced slash selection with a bare Skill call without double counting",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-selection-" });
      const records = [
        {
          type: "user",
          timestamp: start,
          uuid: "slash",
          sessionId: "session",
          message: {
            content:
              "<command-name>/plugin:example</command-name>\n            <command-message>plugin:example</command-message>\n<command-args>test</command-args>",
          },
        },
        { ...call(start, "call"), sessionId: "session" },
      ];
      yield* fs.writeFileString(
        join(root, "one.jsonl"),
        records.map((r) => JSON.stringify(r)).join("\n"),
      );
      const report = yield* (yield* SkillUsage).scan({
        roots: [{ root, harness: "claude-code" }],
        end,
      });
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({
        name: "example",
        uses: 1,
        explicit: 1,
        implicit: 0,
        unknown: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("decodes split UTF-8 and CRLF chunks and reads the final line without a newline", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-lines-" });
    const first = {
      ...call(start, "unicode"),
      message: {
        content: [{ type: "tool_use", id: "unicode", name: "Skill", input: { skill: "café" } }],
      },
    };
    const content = JSON.stringify(first) + "\r\n\r\n" + JSON.stringify(call(start, "last"));
    const bytes = Buffer.from(content);
    const unicodeSplit = bytes.indexOf(Buffer.from("é")) + 1;
    const crlfSplit = bytes.indexOf(13) + 1;
    yield* fs.writeFileString(join(root, "one.jsonl"), content);
    const report = yield* Effect.gen(function* () {
      return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "claude-code" }], end });
    }).pipe(
      Effect.provide(skillUsageLayer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stream: () =>
          Stream.make(
            bytes.subarray(0, unicodeSplit),
            bytes.subarray(unicodeSplit, crlfSplit),
            bytes.subarray(crlfSplit),
          ),
      }),
    );
    expect(report.rows.map((row) => row.name).sort()).toEqual(["café", "example"]);
    expect(report.coverage[0]).toMatchObject({
      records: 2,
      malformed: 0,
      bytesRead: bytes.length,
      changedFiles: 0,
    });
    expect(report.incomplete).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "retains complete records and diagnoses a truncated final record after a source failure",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-lines-" });
      const first = JSON.stringify(call(start, "healthy"));
      yield* fs.writeFileString(
        join(root, "one.jsonl"),
        first + "\n" + JSON.stringify(call(start, "unread")),
      );
      const error = systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stream",
      });
      const report = yield* Effect.gen(function* () {
        return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "claude-code" }], end });
      }).pipe(
        Effect.provide(skillUsageLayer),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stream: () =>
            Stream.make(Buffer.from(first + '\n{"type":')).pipe(Stream.concat(Stream.fail(error))),
        }),
      );
      expect(report.rows).toMatchObject([{ calls: 1, uses: 1 }]);
      expect(report.coverage[0]).toMatchObject({
        records: 1,
        malformed: 1,
        unreadableFiles: 1,
        changedFiles: 1,
      });
      expect(report.incomplete).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "compressed Codex rollouts preserve activity, project filtering and replay suppression",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-zstd-" });
      const plain = join(root, "plain");
      const compressed = join(root, "compressed");
      yield* fs.makeDirectory(plain);
      yield* fs.makeDirectory(compressed);
      const transcript = [
        { type: "session_meta", timestamp: start, payload: { id: "session", cwd: root } },
        { type: "turn_context", timestamp: start, payload: { turn_id: "turn", cwd: root } },
        {
          type: "response_item",
          timestamp: start,
          payload: {
            type: "message",
            role: "user",
            id: "selected",
            content: [
              {
                type: "input_text",
                text: "<skill>\n<name>example</name>\n<path>/synthetic/skills/example/SKILL.md</path>\nInstructions\n</skill>",
              },
            ],
          },
        },
        {
          type: "response_item",
          timestamp: end,
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "outside-window",
            arguments: JSON.stringify({ cmd: "cat /synthetic/skills/outside/SKILL.md" }),
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n");
      const bytes = zstdCompressSync(transcript);
      const plainPath = join(plain, "records.jsonl");
      const compressedPath = join(compressed, "records.jsonl.zst");
      yield* fs.writeFileString(plainPath, transcript);
      yield* fs.writeFile(compressedPath, bytes);
      const scanner = yield* SkillUsage;
      const options = {
        end,
        project: root,
        projections: [
          { path: "/synthetic/skills/example", skillId: "example-id", name: "example" },
        ],
      };
      const expected = yield* scanner.scan({
        ...options,
        roots: [{ root: plain, harness: "codex" }],
      });
      const actual = yield* scanner.scan({
        ...options,
        roots: [{ root: compressed, harness: "codex" }],
      });
      expect(actual.rows).toEqual(expected.rows);
      expect(actual.rows).toMatchObject([{ skillId: "example-id", uses: 1, explicit: 1 }]);
      expect(actual.coverage[0]).toMatchObject({
        files: 1,
        bytes: bytes.length,
        bytesRead: bytes.length,
        records: 4,
        windowRecords: 3,
        skippedFiles: 0,
        changedFiles: 0,
        unreadableFiles: 0,
      });
      expect(actual.incomplete).toBe(false);
      const both = yield* scanner.scan({
        ...options,
        roots: [
          { root: plain, harness: "codex" },
          { root: compressed, harness: "codex" },
        ],
      });
      expect(both.rows).toEqual(expected.rows);
      expect(both.coverage[1].duplicates).toBe(1);
      expect(yield* fs.readFile(compressedPath)).toEqual(bytes);
    }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect(
  "decodes compressed byte chunks, large Unicode records and a final unterminated line",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-zstd-chunks-" });
      const first = {
        ...call(start, "unicode"),
        message: {
          content: [
            {
              type: "tool_use",
              id: "unicode",
              name: "Skill",
              input: { skill: "café", args: "😀é".repeat(30000) },
            },
          ],
        },
      };
      const bytes = zstdCompressSync(
        JSON.stringify(first) + "\r\n\r\n" + JSON.stringify(call(start, "last")),
      );
      yield* fs.writeFile(join(root, "records.jsonl.zst"), bytes);
      const report = yield* Effect.gen(function* () {
        return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "claude-code" }], end });
      }).pipe(
        Effect.provide(skillUsageLayer),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stream: () =>
            Stream.fromIterable(
              Array.from({ length: Math.ceil(bytes.length / 3) }, (_, index) =>
                bytes.subarray(index * 3, index * 3 + 3),
              ),
            ),
        }),
      );
      expect(report.rows.map((row) => row.name).sort()).toEqual(["café", "example"]);
      expect(report.coverage[0]).toMatchObject({
        records: 2,
        malformed: 0,
        bytesRead: bytes.length,
        changedFiles: 0,
        unreadableFiles: 0,
      });
      expect(report.incomplete).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("corrupt compressed files are diagnosed without losing healthy transcripts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-zstd-errors-" });
    yield* fs.writeFileString(join(root, "a-corrupt.jsonl.zst"), "not zstd");
    yield* fs.writeFile(
      join(root, "c-healthy.jsonl.zst"),
      zstdCompressSync(JSON.stringify(call(start, "healthy"))),
    );
    const report = yield* (yield* SkillUsage).scan({
      roots: [{ root, harness: "claude-code" }],
      end,
    });
    expect(report.rows).toMatchObject([{ name: "example", calls: 1 }]);
    expect(report.coverage[0]).toMatchObject({
      files: 2,
      skippedFiles: 0,
      unreadableFiles: 1,
      changedFiles: 0,
    });
    expect(report.incomplete).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skillUsageLayer), Effect.provide(skitLayer)),
);

it.effect("compressed reads keep the inventoried byte bound and diagnose concurrent appends", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-zstd-change-" });
    const path = join(root, "records.jsonl.zst");
    const before = zstdCompressSync(JSON.stringify(call(start, "before")) + "\n");
    const appended = zstdCompressSync(
      JSON.stringify({
        ...call(start, "after"),
        message: {
          content: [{ type: "tool_use", id: "after", name: "Skill", input: { skill: "after" } }],
        },
      }),
    );
    yield* fs.writeFile(path, before);
    const report = yield* Effect.gen(function* () {
      return yield* (yield* SkillUsage).scan({ roots: [{ root, harness: "claude-code" }], end });
    }).pipe(
      Effect.provide(skillUsageLayer),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        stream: (file, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* fs.writeFile(file, appended, { flag: "a" });
              return fs.stream(file, options);
            }),
          ),
      }),
    );
    expect(report.rows).toMatchObject([{ name: "example", calls: 1 }]);
    expect(report.rows).toHaveLength(1);
    expect(report.coverage[0]).toMatchObject({
      bytes: before.length,
      bytesRead: before.length,
      changedFiles: 1,
      unreadableFiles: 0,
    });
    expect(report.incomplete).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
