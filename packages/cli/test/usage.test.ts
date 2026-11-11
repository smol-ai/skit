import { test, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { UsageReport } from "@smolai/skit-core/library/usage";
import { skitLayer } from "@smolai/skit-core/platform";
import { join } from "node:path";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";
import { cliLayer } from "../src/application.js";
import { result } from "../src/commands/result.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/commands/output-frame.js";
import { renderUsage } from "../src/library/usage/present.js";
import { Block } from "../src/terminal/blocks.js";
import { emptyUsageStory, usageStory } from "../src/storybook/usage-stories.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import type { CommandResult } from "../src/commands/types.js";

const table = (blocks: readonly Block[]) =>
  blocks.find((block): block is Extract<Block, { _tag: "Table" }> => block._tag === "Table");
const skills = (blocks: readonly Block[]) => table(blocks)?.rows.map((row) => row[0]?.[0]) ?? [];

test("presents skill activity without internal counters; preserves the public JSON contract", () => {
  expect(renderUsage(emptyUsageStory)).toEqual([
    Block.Heading({ text: "Skill activity (7 days)" }),
    Block.Note({ text: [{ dim: "1 Oct – 8 Oct (UTC)" }] }),
    Block.Note({ text: ["No skill activity found."] }),
  ]);
  expect(renderUsage(usageStory)).toEqual([
    Block.Heading({ text: "Skill activity (7 days)" }),
    Block.Note({ text: [{ dim: "1 Oct – 8 Oct (UTC)" }] }),
    Block.Table({
      columns: [
        { title: "Skill" },
        { title: "Harness" },
        { title: "Uses", align: "end" },
        { title: "Explicit", align: "end" },
        { title: "Implicit", align: "end" },
        { title: "Last seen" },
      ],
      rows: [[["example"], ["claude-code, codex"], ["3"], ["1"], ["2"], ["7 Oct"]]],
    }),
  ]);
  expect(renderUsage({ ...usageStory, project: "/work/app" })).toContainEqual(
    Block.Fields({ rows: [{ label: "Project", value: ["/work/app"] }] }),
  );
  const json = renderResultFrame(result("usage", usageStory), {
    ...defaultTerminalEnvironment,
    format: "json",
  });
  expect(JSON.parse(json?.stdout ?? "{}")).toEqual({
    schema: "skit.usage.v4",
    data: usageStory,
  });
});

test("summarizes by name without dumping paths, scan internals, or test-fixture reads", () => {
  const base = usageStory.rows[0];
  const report = {
    ...usageStory,
    rows: [
      ...usageStory.rows,
      {
        ...base,
        name: "library",
        identity: "unresolved" as const,
        path: "/synthetic/test/fixtures/library/SKILL.md",
        loads: 0,
        reads: 1,
      },
      {
        ...base,
        name: "review",
        path: "/synthetic/test/fixtures/library/skills/review/SKILL.md",
        loads: 0,
        reads: 1,
      },
    ],
  };
  expect(skills(renderUsage(report))).toEqual(["example"]);
  // JSON retains all observations omitted from the human table.
  const json = renderResultFrame(result("usage", report), {
    ...defaultTerminalEnvironment,
    format: "json",
  });
  expect(JSON.parse(json?.stdout ?? "{}").data.rows).toHaveLength(4);
});

test("keeps infrequent skills visible in the compact table", () => {
  const report = {
    ...emptyUsageStory,
    rows: Array.from({ length: 12 }, (_, i) => ({
      ...usageStory.rows[0],
      name: `skill-${i}`,
      reads: 12 - i,
      loads: 0,
    })),
  };
  expect(skills(renderUsage(report))).toHaveLength(12);
  expect(skills(renderUsage(report))).toContain("skill-11");
});

it.effect("exposes the read-only command and output schema", () =>
  Effect.gen(function* () {
    const commands = yield* commandDescriptions(skitCommand);
    const usage = commands.find((c) => c.path.join(" ") === "usage");
    expect(usage).toMatchObject({
      stability: "experimental",
      effects: { capabilities: ["filesystem.read"] },
      outputSchemas: expect.arrayContaining(["skit.usage.v4"]),
      interactive: false,
    });
  }).pipe(Effect.provide(cliLayer(false, "/tmp/skit-usage-contract"))),
);

it.effect("runs the real command against isolated transcripts without creating Library state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-usage-cli-" });
    const home = join(root, "library");
    const codex = join(root, "codex");
    yield* fs.makeDirectory(join(codex, "sessions"), { recursive: true });
    const native = {
      type: "response_item",
      timestamp: "2026-10-01T00:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        id: "native-load",
        content: [
          {
            type: "input_text",
            text: "<skill>\n<name>example</name>\n<path>/synthetic/skills/example/SKILL.md</path>\nInstructions\n</skill>",
          },
        ],
      },
    };
    const transcript = join(codex, "sessions/example.jsonl");
    const content = JSON.stringify(native);
    yield* fs.writeFileString(transcript, content);
    let captured: CommandResult | undefined;
    yield* runCommandTree(
      skitCommand,
      [
        "usage",
        "--harness",
        "codex",
        "--codex-home",
        codex,
        "--home",
        home,
        "--end",
        "2026-10-08T00:00:00Z",
        "--json",
      ],
      "test",
    ).pipe(
      Effect.provide(
        rendererTestLayer({
          result: (value) =>
            Effect.sync(() => {
              captured = value;
            }),
          failure: (value) => Effect.die(value),
        }),
      ),
    );
    expect(captured?.schema).toBe("skit.usage.v4");
    const report = yield* Schema.decodeUnknownEffect(UsageReport)(captured?.data);
    expect(report.rows).toMatchObject([
      {
        name: "example",
        uses: 1,
        explicit: 1,
        implicit: 0,
        unknown: 0,
        loads: 1,
        calls: 0,
        reads: 0,
      },
    ]);
    expect(yield* fs.exists(home)).toBe(false);
    expect(yield* fs.readFileString(transcript)).toBe(content);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

test("orders by invocation counts rather than repeated evidence", () => {
  const base = usageStory.rows[0];
  const report = {
    ...emptyUsageStory,
    rows: [
      { ...base, name: "older", uses: 1, reads: 100, lastSeenAt: "2026-10-02T12:00:00Z" },
      { ...base, name: "recent", uses: 2, reads: 1, lastSeenAt: "2026-10-07T12:00:00Z" },
    ],
  };
  expect(skills(renderUsage(report))).toEqual(["recent", "older"]);
});
