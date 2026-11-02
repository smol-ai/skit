import { DateTime, Equivalence, Option } from "effect";
import { describe, expect, test } from "vitest";
import { Merge } from "../src/index.js";

const some = Option.some;
const none = Option.none;
const at = (iso: string) => DateTime.makeUnsafe(iso);
const clean = <A>(result: Merge.Result<A>) => {
  if (result._tag !== "Clean") throw new Error("expected a clean merge");
  return result;
};
const conflicts = <A>(result: Merge.Result<A>) => {
  if (result._tag !== "Conflicts") throw new Error("expected conflicts");
  return result;
};
const kept = <A>(result: Merge.Result<A>) =>
  clean(result).choices.map(({ conflict, kept }) => [conflict.at, kept]);

const skill = (...instructions: string[]) =>
  `---\nname: review\ndescription: Review code.\n---\n# Review\n${instructions.join("\n")}\n`;
const base = skill("Check naming.", "Keep comments brief.");

describe("lines", () => {
  test("edits to different lines combine, adjacent lines included", () => {
    const result = clean(
      Merge.run(Merge.lines, {
        base: some(base),
        ours: some(skill("Check naming and tests.", "Keep comments brief.")),
        theirs: some(skill("Check naming.", "Explain each finding.")),
      }),
    );
    expect(result.value).toEqual(some(skill("Check naming and tests.", "Explain each finding.")));
    expect(result.choices).toEqual([]);
  });

  test("independent insertions in different places combine", () => {
    const result = clean(
      Merge.run(Merge.lines, {
        base: some("a\nb\nc\n"),
        ours: some("first\na\nb\nc\n"),
        theirs: some("a\nb\nc\nlast\n"),
      }),
    );
    expect(result.value).toEqual(some("first\na\nb\nc\nlast\n"));
  });

  test("the same change on both sides is not a conflict", () => {
    const result = clean(
      Merge.run(Merge.lines, {
        base: some("a\nb\nc\nd\n"),
        ours: some("a\nB\nc\nd\n"),
        theirs: some("a\nB\nc\nD\n"),
      }),
    );
    expect(result.value).toEqual(some("a\nB\nc\nD\n"));
  });

  const sameLine = {
    base: some(base),
    ours: some(skill("Check naming.", "Explain each finding.")),
    theirs: some(skill("Check naming.", "One comment per file.")),
  };

  test("a conflict on one line leaves the other side's other edits in place", () => {
    const result = Merge.run(
      Merge.lines,
      { ...sameLine, theirs: some(skill("Check names.", "One comment per file.")) },
      Merge.always("ours"),
    );
    expect(clean(result).value).toEqual(some(skill("Check names.", "Explain each finding.")));
    expect(kept(result)).toEqual([[[7], "ours"]]);
  });

  test("the later edit wins, whichever side it is on", () => {
    const times = {
      ours: some(at("2026-11-01T09:00:00.000Z")),
      theirs: some(at("2026-11-01T10:00:00.000Z")),
    };
    const result = Merge.run(
      Merge.lines,
      sameLine,
      Merge.latest((side) => times[side]),
    );
    expect(clean(result).value).toEqual(sameLine.theirs);
    expect(kept(result)).toEqual([[[7], "theirs"]]);
  });

  test("an undecided conflict has no merged value and keeps all three versions", () => {
    const result = conflicts(Merge.run(Merge.lines, sameLine));
    expect(result).not.toHaveProperty("value");
    expect(result.conflicts).toEqual([
      {
        at: [7],
        base: some("Keep comments brief.\n"),
        ours: some("Explain each finding.\n"),
        theirs: some("One comment per file.\n"),
      },
    ]);
  });

  test("resolve decides an earlier result's conflicts", () => {
    const result = Merge.resolve(Merge.run(Merge.lines, sameLine), Merge.always("theirs"));
    expect(clean(result).value).toEqual(sameLine.theirs);
  });

  test("a chooser that abstains leaves the conflict undecided", () => {
    const result = Merge.run(
      Merge.lines,
      sameLine,
      Merge.latest(() => none()),
    );
    expect(conflicts(result).conflicts).toHaveLength(1);
  });

  test("blocks of different lengths conflict as a whole", () => {
    const result = conflicts(
      Merge.run(Merge.lines, {
        base: some(base),
        ours: some(skill("Check naming.", "Explain each finding.")),
        theirs: some(skill("Check naming.", "Explain each finding.", "Extra.")),
      }),
    );
    expect(result.conflicts).toEqual([
      expect.objectContaining({ theirs: some("Explain each finding.\nExtra.\n") }),
    ]);
  });

  test("insertions at the same point conflict", () => {
    const result = Merge.run(
      Merge.lines,
      { base: some("a\nb\n"), ours: some("a\nx\nb\n"), theirs: some("a\ny\nb\n") },
      Merge.always("ours"),
    );
    expect(clean(result).value).toEqual(some("a\nx\nb\n"));
    expect(clean(result).choices).toHaveLength(1);
  });

  test("text created on both sides without a base is one conflict", () => {
    const result = conflicts(
      Merge.run(Merge.lines, { base: none(), ours: some("a\n"), theirs: some("b\n") }),
    );
    expect(result.conflicts.map((found) => found.at)).toEqual([[]]);
  });
});

describe("absence", () => {
  const value = Merge.whole(Equivalence.String);

  test("a deletion against an unchanged side deletes", () => {
    const result = clean(Merge.run(value, { base: some("a"), ours: none(), theirs: some("a") }));
    expect(result.value).toEqual(none());
    expect(result.choices).toEqual([]);
  });

  test("an edit beats a deletion only when the chooser says so", () => {
    const versions = { base: some("a"), ours: none<string>(), theirs: some("b") };
    expect(
      clean(Merge.run(value, versions, Merge.prefer(Merge.present, Merge.always("ours")))).value,
    ).toEqual(some("b"));
    expect(clean(Merge.run(value, versions, Merge.always("ours"))).value).toEqual(none());
  });
});

describe("record", () => {
  const files = Merge.record(Merge.lines);
  const versions = {
    base: some({ "a.md": "1\n", "b.md": "1\n", "gone.md": "x\n" }),
    ours: some({ "a.md": "ours\n", "b.md": "1\n", "new.md": "n\n" }),
    theirs: some({ "a.md": "theirs\n", "b.md": "2\n" }),
  };

  test("each key merges on its own and conflicts say where they are", () => {
    const result = Merge.run(files, versions, Merge.always("ours"));
    expect(clean(result).value).toEqual(some({ "a.md": "ours\n", "b.md": "2\n", "new.md": "n\n" }));
    expect(kept(result)).toEqual([[["a.md", 1], "ours"]]);
  });

  test("one undecided key leaves the whole record without a value", () => {
    const result = conflicts(Merge.run(files, versions));
    expect(result.conflicts.map((found) => found.at)).toEqual([["a.md", 1]]);
  });

  test("an override merges its key its own way", () => {
    const tags = Merge.record<unknown>(Merge.whole(Equivalence.strictEqual()), {
      tags: Merge.set(Equivalence.strictEqual()) as Merge.Merger<unknown>,
    });
    const result = clean(
      Merge.run(tags, {
        base: some({ tags: ["a"] }),
        ours: some({ tags: ["a", "b"] }),
        theirs: some({ tags: ["a", "c"] }),
      }),
    );
    expect(result.value).toEqual(some({ tags: ["a", "b", "c"] }));
  });
});

describe("struct", () => {
  test("each field merges with its own merger", () => {
    const note = Merge.struct<{ title: string; body: string }>({
      title: Merge.whole(Equivalence.String),
      body: Merge.lines,
    });
    const result = clean(
      Merge.run(note, {
        base: some({ title: "Notes", body: "a\nb\n" }),
        ours: some({ title: "Notes", body: "A\nb\n" }),
        theirs: some({ title: "Better notes", body: "a\nB\n" }),
      }),
    );
    expect(result.value).toEqual(some({ title: "Better notes", body: "A\nB\n" }));
  });
});

describe("choosers", () => {
  const found: Merge.Conflict = { at: [], base: some(0), ours: some(1), theirs: some(2) };

  test("latest abstains on unknown or equal times", () => {
    const time = some(at("2026-11-01T00:00:00.000Z"));
    expect(Merge.latest((side) => (side === "ours" ? none() : time))(found)).toEqual(none());
    expect(Merge.latest(() => time)(found)).toEqual(none());
  });

  test("prefer takes the first chooser that decides", () => {
    expect(Merge.prefer(Merge.undecided, Merge.always("theirs"))(found)).toEqual(some("theirs"));
    expect(Merge.prefer(Merge.undecided)(found)).toEqual(none());
  });
});
