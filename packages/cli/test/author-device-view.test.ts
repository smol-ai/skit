import { expect, test } from "vitest";
import { DateTime, Option } from "effect";
import { type History, Merge } from "@smolai/skit-core";
import { authorDecider, authorTree } from "../src/workflows/author/device-view.js";

const entry = (path: string, text: string): History.Tree[number] => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: new TextEncoder().encode(text),
});
const merge = (
  base: History.Tree,
  ours: History.Tree,
  theirs: History.Tree,
  exclusions: { excluded?: ReadonlyArray<string>; previouslyExcluded?: ReadonlyArray<string> } = {},
  editedAt = { ours: DateTime.makeUnsafe(1), theirs: DateTime.makeUnsafe(1) },
) =>
  Merge.runDecided(
    authorTree({
      excluded: new Set(exclusions.excluded),
      previouslyExcluded: new Set(exclusions.previouslyExcluded),
    }),
    { base: Option.some(base), ours: Option.some(ours), theirs: Option.some(theirs) },
    authorDecider(editedAt),
  );
const paths = (result: Merge.Clean<History.Tree>) =>
  Option.map(result.value, (tree) => tree.map((item) => item.path).sort());

test("excluded local content cannot influence the merged tree or replace its remote counterpart", () => {
  const result = merge(
    [entry(".env", "old remote"), entry("notes.md", "base")],
    [entry(".env", "private local"), entry("notes.md", "local edit")],
    [entry(".env", "new remote"), entry("notes.md", "base")],
    { excluded: [".env"] },
  );
  expect(result.value).toEqual(
    Option.some([entry("notes.md", "local edit"), entry(".env", "new remote")]),
  );
  expect(result.choices).toEqual([]);
});

test("newly excluded paths do not count as local deletions and absent remote exclusions stay absent", () => {
  const result = merge(
    [entry("p.txt", "old"), entry("q.txt", "old q")],
    [],
    [entry("p.txt", "remote")],
    { excluded: ["p.txt", "q.txt"] },
  );
  expect(result.value).toEqual(Option.some([entry("p.txt", "remote")]));
});

test("a previously excluded, never-materialized path becomes a remote addition when unignored", () => {
  const remote = [entry("p.txt", "remote")];
  const result = merge(remote, [], remote, { previouslyExcluded: ["p.txt"] });
  expect(result.value).toEqual(Option.some(remote));
});

test("unignored private content and unseen remote content are both additions; ours wins a tie", () => {
  const result = merge(
    [entry("p.txt", "remote")],
    [entry("p.txt", "formerly private")],
    [entry("p.txt", "remote")],
    { previouslyExcluded: ["p.txt"] },
  );
  expect(result.value).toEqual(Option.some([entry("p.txt", "formerly private")]));
  expect(result.choices.map(({ conflict, kept }) => [conflict.at[0], kept])).toEqual([
    ["p.txt", "ours"],
  ]);
});

test("a formerly excluded remote deletion cannot delete newly visible local content", () => {
  const result = merge([entry("p.txt", "remote")], [entry("p.txt", "formerly private")], [], {
    previouslyExcluded: ["p.txt"],
  });
  expect(paths(result)).toEqual(Option.some(["p.txt"]));
  expect(result.choices).toEqual([]);
});

test("an overlap keeps the later edit, and an edit beats a deletion", () => {
  const later = merge(
    [entry("a.md", "base")],
    [entry("a.md", "ours")],
    [entry("a.md", "theirs")],
    {},
    { ours: DateTime.makeUnsafe(1), theirs: DateTime.makeUnsafe(2) },
  );
  expect(later.value).toEqual(Option.some([entry("a.md", "theirs")]));
  const deleted = merge(
    [entry("a.md", "base")],
    [],
    [entry("a.md", "theirs")],
    {},
    { ours: DateTime.makeUnsafe(5), theirs: DateTime.makeUnsafe(2) },
  );
  expect(deleted.value).toEqual(Option.some([entry("a.md", "theirs")]));
});
