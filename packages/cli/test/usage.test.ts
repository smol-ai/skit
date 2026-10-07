import { test, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { UsageReport, skitLayer } from "@smolai/skit-core";
import { join } from "node:path";
import { commandDescriptions } from "../src/commands/manifest.js";
import { skitCommand } from "../src/commands/tree.js";
import { commandApplicationLayer } from "../src/application.js";
import { outputContracts } from "../src/commands/output-contracts.js";
import { result } from "../src/handlers/contracts.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/presentation/output-frame.js";
import { renderUsage } from "../src/presentation/usage.js";
import { emptyUsageStory, observedUsageStory } from "../src/storybook/usage-stories.js";
import { runCommandTree } from "../src/commands/runtime.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import type { CommandResult } from "../src/commands/types.js";

test("presents separate evidence and diagnostics; encodes the public JSON contract", () => {
  expect(renderUsage(emptyUsageStory)).toContain("No activity observed.");
  const body = renderUsage(observedUsageStory);
  expect(body).toContain("Calls | Loads | Reads");
  expect(body).toContain("example | codex | 0 | 1 | 3");
  expect(body).toContain("example | claude-code | 2 | 0 | 0");
  expect(body).toContain("1 unsupported tool wrappers");
  expect(body).toContain("report is incomplete");
  expect(body).toContain("same invocation");
  const json = renderResultFrame(result("usage", outputContracts.usage, observedUsageStory), {
    ...defaultTerminalEnvironment,
    format: "json",
  });
  expect(JSON.parse(json?.stdout ?? "{}")).toEqual({
    schema: "skit.usage.v1",
    data: observedUsageStory,
  });
});

test("does not render terminal controls embedded in observed names or paths", () => {
  const report = {
    ...observedUsageStory,
    rows: [
      {
        ...observedUsageStory.rows[0],
        name: "example\x1b[31m",
        path: "/synthetic/\nexample/SKILL.md",
      },
    ],
  };
  const body = renderUsage(report);
  expect(body).not.toContain("\x1b");
  expect(body).toContain("/synthetic/ example/SKILL.md");
});

it.effect("exposes the read-only command and output schema", () =>
  Effect.gen(function* () {
    const commands = yield* commandDescriptions(skitCommand);
    const usage = commands.find((c) => c.path.join(" ") === "usage");
    expect(usage).toMatchObject({
      effects: { capabilities: ["filesystem.read"] },
      outputSchemas: expect.arrayContaining(["skit.usage.v1"]),
      interactive: false,
    });
  }).pipe(Effect.provide(commandApplicationLayer(false, "/tmp/skit-usage-contract"))),
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
    expect(captured?.schema).toBe("skit.usage.v1");
    const report = yield* Schema.decodeUnknownEffect(UsageReport)(captured?.data);
    expect(report.rows).toMatchObject([{ name: "example", loads: 1, calls: 0, reads: 0 }]);
    expect(yield* fs.exists(home)).toBe(false);
    expect(yield* fs.readFileString(transcript)).toBe(content);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
