import { Block } from "../src/terminal/blocks.js";
import { describeFailure } from "../src/terminal/failure.js";
import type { CommandFailure } from "../src/commands/types.js";
import { Cause, Effect } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { result } from "../src/commands/result.js";
import {
  defaultTerminalEnvironment,
  renderFailureFrame,
  renderNoteFrame,
  renderStepFrame,
  renderResultFrame,
} from "../src/commands/output-frame.js";

describe("terminal output frames", () => {
  it.effect("routes successful results and encodes the JSON contract", () =>
    Effect.sync(() => {
      const commandResult = result("version", { version: "1.2.3" });
      const human = renderResultFrame(commandResult, defaultTerminalEnvironment);
      expect(human.stderr).toBe("");
      expect(human.exitCode).toBe(0);
      const json = renderResultFrame(commandResult, {
        ...defaultTerminalEnvironment,
        format: "json",
      });
      expect(JSON.parse(json.stdout)).toEqual({
        schema: "skit.version.v1",
        data: { version: "1.2.3" },
      });
      expect(json.stderr).toBe("");
      expect(json.exitCode).toBe(0);
    }),
  );

  it.effect("keeps failures on stderr with their semantic exit code", () =>
    Effect.sync(() => {
      const failure: CommandFailure = {
        code: "CONFLICT",
        cause: Cause.fail(new Error("Sync stopped")),
        ...describeFailure({
          summary: ["Sync stopped"],
          details: [
            Block.List({ items: [{ text: ["cli-ux"], detail: ["differs between devices"] }] }),
          ],
          next: ["Run ", { code: "skit doctor" }],
        }),
      };
      const frame = renderFailureFrame(failure, defaultTerminalEnvironment);
      expect(frame.stdout).toBe("");
      expect(frame.exitCode).toBe(1);
      expect(
        JSON.parse(
          renderFailureFrame(failure, { ...defaultTerminalEnvironment, format: "json" }).stderr,
        ).error,
      ).toEqual({
        code: "CONFLICT",
        cause: [{ _tag: "Fail", error: { name: "Error", message: "Sync stopped" } }],
      });
    }),
  );
});

it.effect("notes and steps stay off stdout and are suppressed in JSON mode", () =>
  Effect.sync(() => {
    const body = [
      Block.Note({ text: ["Review these changes carefully before applying them to the Library."] }),
    ];
    const environment = { ...defaultTerminalEnvironment, color: false, width: 40 };
    const note = renderNoteFrame(body, "Review", environment);
    expect(note.stdout).toBe("");
    const step = renderStepFrame({ index: 2, total: 3, title: "Review" }, body, environment);
    expect(step.stdout).toBe("");
    expect(renderNoteFrame(body, "Review", { ...environment, format: "json" })).toEqual({
      stdout: "",
      stderr: "",
    });
    expect(
      renderStepFrame({ index: 2, total: 3, title: "Review" }, body, {
        ...environment,
        format: "json",
      }),
    ).toEqual({ stdout: "", stderr: "" });
  }),
);
