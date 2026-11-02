import { DateTime, Option, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { conflictKind, mergeAuthorTree, Merge, TreeFile } from "../src/index.js";

const file = (text: string): TreeFile => {
  const bytes = new TextEncoder().encode(text);
  return { path, kind: "file", bytes, mode: 0o644 };
};
const path = "skills/review/SKILL.md";
type EditTimes = { ours?: string; theirs?: string };
/** Author sync's rule: an edit beats a deletion, then the later edit, then ours. */
const authorRule = (times: EditTimes) =>
  Merge.prefer(
    Merge.present,
    Merge.latest((side) => Option.map(Option.fromUndefinedOr(times[side]), DateTime.makeUnsafe)),
    Merge.always("ours"),
  );
const merge = (base: string, ours: string, theirs: string, times: EditTimes = {}) => {
  const result = Merge.run(
    mergeAuthorTree,
    {
      base: Option.some([file(base)]),
      ours: Option.some([file(ours)]),
      theirs: Option.some([file(theirs)]),
    },
    authorRule(times),
  );
  if (result._tag !== "Clean") throw new Error("expected a clean merge");
  const choices = result.choices.map(({ conflict, kept }) => ({
    path: String(conflict.at[0]),
    kind: conflictKind(conflict),
    kept,
  }));
  return {
    choices,
    text: new TextDecoder().decode(
      Schema.decodeUnknownSync(TreeFile)(Option.getOrThrow(result.value)[0]).bytes,
    ),
  };
};

const base = `---
name: review
# Keep this short.
description: Review code.
allowed-tools:
  - Read
  - Grep
---
# Review
Check naming.
`;

describe("SKILL.md frontmatter", () => {
  test("edits to different fields both survive and local comments stay", () => {
    const { choices, text } = merge(
      base,
      base.replace("description: Review code.", "description: Review code carefully."),
      base.replace("  - Grep\n", "  - Grep\n  - Bash\n"),
    );
    expect(choices).toEqual([]);
    expect(text).toContain("# Keep this short.");
    expect(text).toContain("description: Review code carefully.");
    expect(text).toContain("- Bash");
  });

  test("neighbouring field edits that one text chunk would lose both survive", () => {
    const { choices, text } = merge(
      base,
      base.replace("name: review", "name: code-review"),
      base.replace("description: Review code.", "description: Review all code."),
    );
    expect(choices).toEqual([]);
    expect(text).toContain("name: code-review");
    expect(text).toContain("description: Review all code.");
  });

  test("a formatting-only change never overlaps a value change", () => {
    const { choices, text } = merge(
      base,
      base.replace("description: Review code.", 'description: "Review code."'),
      base.replace("description: Review code.", "description: Review every change."),
    );
    expect(choices).toEqual([]);
    // The remote value, written in the local quoting style.
    expect(text).toContain('description: "Review every change."');
  });

  test("the same field changed on both sides goes to the later edit", () => {
    const local = base.replace("description: Review code.", "description: Local wording.");
    const remote = base.replace("description: Review code.", "description: Remote wording.");
    const { choices, text } = merge(base, local, remote, {
      ours: "2026-11-01T09:00:00.000Z",
      theirs: "2026-11-01T10:00:00.000Z",
    });
    expect(text).toContain("description: Remote wording.");
    expect(choices).toEqual([{ path, kind: "both_modified", kept: "theirs" }]);
  });

  test("allowed-tools merges as a set: both additions kept, removals honoured", () => {
    const { choices, text } = merge(
      base,
      base.replace("  - Grep\n", "  - Grep\n  - Edit\n"),
      base.replace("  - Read\n  - Grep\n", "  - Grep\n  - Bash\n"),
    );
    expect(choices).toEqual([]);
    const tools = text.match(/allowed-tools:\n((?: {2}- .+\n)+)/u)![1];
    expect(tools).toBe("  - Grep\n  - Edit\n  - Bash\n");
  });

  test("allowed-tools written as one string merges as a whole value", () => {
    const inline = base.replace(
      "allowed-tools:\n  - Read\n  - Grep\n",
      "allowed-tools: Read, Grep\n",
    );
    const { choices, text } = merge(
      inline,
      inline.replace("allowed-tools: Read, Grep", "allowed-tools: Read, Grep, Edit"),
      inline.replace("Check naming.", "Check naming and tests."),
    );
    expect(choices).toEqual([]);
    expect(text).toContain("allowed-tools: Read, Grep, Edit");
    expect(text).toContain("Check naming and tests.");
  });

  test("allowed-tools as a string on one side and a list on the other is one choice", () => {
    const inline = base.replace("allowed-tools:\n  - Read\n  - Grep\n", "allowed-tools: Read\n");
    const { choices, text } = merge(
      base,
      inline,
      base.replace("  - Grep\n", "  - Grep\n  - Bash\n"),
      { ours: "2026-11-01T10:00:00.000Z", theirs: "2026-11-01T09:00:00.000Z" },
    );
    expect(choices).toEqual([{ path, kind: "both_modified", kept: "ours" }]);
    expect(text).toContain("allowed-tools: Read\n");
  });

  test("metadata that is not a mapping merges as a whole value", () => {
    const withMetadata = base.replace("allowed-tools:", "metadata: internal\nallowed-tools:");
    const { choices, text } = merge(
      withMetadata,
      withMetadata.replace("metadata: internal", "metadata: shared"),
      withMetadata.replace("description: Review code.", "description: Review all code."),
    );
    expect(choices).toEqual([]);
    expect(text).toContain("metadata: shared");
    expect(text).toContain("description: Review all code.");
  });

  test("frontmatter and body merge independently", () => {
    const { choices, text } = merge(
      base,
      base.replace("description: Review code.", "description: Changed here."),
      base.replace("Check naming.", "Check naming and tests."),
    );
    expect(choices).toEqual([]);
    expect(text).toContain("description: Changed here.");
    expect(text).toContain("Check naming and tests.");
  });

  test("unparseable frontmatter falls back to the line merge", () => {
    const broken = base.replace("name: review", "name: [unfinished");
    const { choices, text } = merge(broken, broken.replace("Check naming.", "Local body."), broken);
    expect(choices).toEqual([]);
    expect(text).toContain("Local body.");
    expect(text).toContain("name: [unfinished");
  });
});
