import { expect, test } from "vitest";
import { Schema } from "effect";
import { SetupApplied } from "@smolai/skit-core/library/setup";
import { result } from "../src/commands/result.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/commands/output-frame.js";
import { presentContract } from "../src/commands/output-presenters.js";
import { Block } from "../src/terminal/blocks.js";

const data = {
  planId: `sha256:${"a".repeat(64)}` as const,
  imported: [],
  added: [],
  reconnected: [],
  installedSkills: [],
  actions: [],
  leftAlone: [
    {
      name: "review",
      paths: ["/home/person/.agents/skills/review"],
      reason: "divergent-copies" as const,
    },
  ],
};

test("setup explains a left-alone skill while JSON retains its machine reason", () => {
  const output = result("setupApplied", data);
  expect(presentContract(output, defaultTerminalEnvironment)).toContainEqual(
    Block.Group({
      title: "Left alone",
      children: [
        Block.Table({
          columns: [{ title: "Skill" }, { title: "Reason" }],
          rows: [[["review"], ["Copies of this skill have different contents"]]],
        }),
      ],
    }),
  );
  const json = renderResultFrame(output, { ...defaultTerminalEnvironment, format: "json" });
  expect(JSON.parse(json.stdout).data.leftAlone[0].reason).toBe("divergent-copies");
});

test("setup results reject arbitrary prose as a reason", () => {
  expect(() =>
    Schema.decodeUnknownSync(SetupApplied)({
      ...data,
      leftAlone: [{ ...data.leftAlone[0], reason: "Something went wrong" }],
    }),
  ).toThrow();
});
