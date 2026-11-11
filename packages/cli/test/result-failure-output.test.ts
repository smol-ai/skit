import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { CommandFailed } from "@smolai/skit-core/library/source/failures";
import { LibraryChanged } from "@smolai/skit-core/library";
import { makeCollectionId } from "@smolai/skit-core/universal/consumer";
import { sourceUpdateOutput, UpdateResult } from "../src/library/update/output.js";
import { SetupFailureOutput } from "../src/library/setup/actions.js";
import { outputStories } from "../src/storybook/output-stories.js";
import { presentContract } from "../src/commands/output-presenters.js";
import { result } from "../src/commands/result.js";
import { Block } from "../src/terminal/blocks.js";
import { renderUpdate } from "../src/library/update/present.js";

const context = { color: false, detail: "summary" as const };

test("the result boundary preserves a native update cause and formats diagnostics after decoding", () => {
  const cause = Cause.combine(
    Cause.fail(
      new CommandFailed({
        command: "git fetch origin",
        exitCode: 128,
        stderr: "fatal: unavailable\n  original process detail",
      }),
    ),
    Cause.die(new LibraryChanged({ path: "/library/state.json" })),
  );
  const id = makeCollectionId();
  const data = sourceUpdateOutput([
    {
      status: "failed",
      subject_id: id,
      subject_kind: "collection",
      label: "review-tools",
      source: "https://git.example.test/review-tools",
      phase: "install",
      source_imported: true,
      error: cause,
    },
  ]);
  const first = data[0];
  if (!first || !("status" in first)) throw new Error("Missing failed update");
  expect(first.error.cause).toBe(cause);
  expect(first.error).not.toHaveProperty("message");
  expect(first.error).not.toHaveProperty("remediation");
  const wire = Schema.encodeSync(UpdateResult)(data);
  const decoded = Schema.decodeUnknownSync(UpdateResult)(JSON.parse(JSON.stringify(wire)));
  expect(renderUpdate(decoded)).toEqual(renderUpdate(data));
  const group = renderUpdate(decoded).find((block) => block._tag === "Group");
  if (!group || group._tag !== "Group") throw new Error("Missing update details");
  expect(group.children).toContainEqual(
    Block.Verbatim({ text: "fatal: unavailable\n  original process detail" }),
  );
  const next = group.children.filter(
    (block) => block._tag === "Fields" && block.rows.some((row) => row.label === "Next"),
  );
  expect(next).toHaveLength(1);
  expect(next[0]).toMatchObject({
    rows: [{ label: "Next", value: expect.arrayContaining([{ code: `skit update ${id}` }]) }],
  });
});

for (const story of outputStories.filter(
  (story) =>
    story._tag === "Result" &&
    ((story.group === "update" &&
      ["source-failed", "install-failed-after-import", "registry-sync-failed"].includes(
        story.name,
      )) ||
      (story.group === "setup" && story.name === "failed")),
)) {
  test(`${story.group}/${story.name} carries facts and reconstructs the same semantic output`, () => {
    if (story._tag !== "Result") throw new Error("Expected result story");
    const original = story.result;
    if (original.contract === "setupFailed") {
      const wire = Schema.encodeSync(SetupFailureOutput)(original.data);
      expect(wire).not.toHaveProperty("message");
      expect(wire).not.toHaveProperty("remediation");
      const decoded = Schema.decodeUnknownSync(SetupFailureOutput)(
        JSON.parse(JSON.stringify(wire)),
      );
      expect(presentContract(result("setupFailed", decoded), context)).toEqual(
        presentContract(original, context),
      );
    } else if (original.contract === "update") {
      const wire = Schema.encodeSync(UpdateResult)(original.data);
      expect(JSON.stringify(wire)).not.toContain('"remediation"');
      const decoded = Schema.decodeUnknownSync(UpdateResult)(JSON.parse(JSON.stringify(wire)));
      expect(presentContract(result("update", decoded), context)).toEqual(
        presentContract(original, context),
      );
    } else throw new Error("Unexpected result contract");
  });
}
