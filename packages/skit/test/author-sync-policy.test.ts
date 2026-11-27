import { describe, expect, test, vi } from "vitest";
import { Option } from "effect";
import type * as History from "../src/history/history.js";
import * as SkillMoves from "../src/author/merge/skill-moves.js";
import * as Merge from "../src/sync/merge.js";
import {
  authorDecider,
  authorTree,
  mergeAuthorRevisions,
} from "../src/author/internal/sync-policy.js";

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
  editedAt = { ours: 1, theirs: 1 },
) =>
  Merge.runDecided(
    authorTree({
      excluded: new Set(exclusions.excluded),
      previouslyExcluded: new Set(exclusions.previouslyExcluded),
    }),
    { base: Option.some(base), ours: Option.some(ours), theirs: Option.some(theirs) },
    authorDecider({
      ours: Object.fromEntries(ours.map((entry) => [entry.path, editedAt.ours])),
      theirs: Object.fromEntries(theirs.map((entry) => [entry.path, editedAt.theirs])),
    }),
  );
const paths = (result: Merge.Clean<History.Tree>) =>
  Option.map(result.value, (tree) => tree.map((item) => item.path).sort());

describe("skit author sync", () => {
  describe("Choosing what changes", () => {
    describe("Changing ignore rules does not turn excluded files into deletions.", () => {
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
    });
  });
  describe("Combining edits", () => {
    describe("For overlapping edits, the version observed later wins.", () => {
      test("a renamed synthesized file carries the latest contributing path time", () => {
        using alignment = vi.spyOn(SkillMoves, "followSkillMoves");
        const skill = (name: string, body: string) =>
          `---\nname: ${name}\ndescription: Release notes.\n---\n# Notes\n${body}\nKeep them short.\n`;
        const result = mergeAuthorRevisions(
          {
            base: Option.some([entry("notes/SKILL.md", skill("notes", "base"))]),
            ours: Option.some([entry("changelog/SKILL.md", skill("changelog", "older body"))]),
            theirs: Option.some([entry("notes/SKILL.md", skill("notes", "later body"))]),
          },
          { ours: { "changelog/SKILL.md": 1 }, theirs: { "notes/SKILL.md": 2 } },
        );
        expect(result.value).toEqual(
          Option.some([entry("changelog/SKILL.md", skill("changelog", "later body"))]),
        );
        expect(result.edits).toEqual({ "changelog/SKILL.md": 2 });
        expect(alignment).toHaveBeenCalledTimes(1);
      });
      test("a decomposed filename keeps its canonical edit time during merge", () => {
        const native = "cafe\u0301.bin";
        const canonical = native.normalize("NFC");
        const base = [{ ...entry(native, "base"), bytes: Uint8Array.of(0, 1) }];
        const ours = [{ ...entry(native, "ours"), bytes: Uint8Array.of(0, 2) }];
        const theirs = [{ ...entry(native, "theirs"), bytes: Uint8Array.of(0, 3) }];
        const result = mergeAuthorRevisions(
          { base: Option.some(base), ours: Option.some(ours), theirs: Option.some(theirs) },
          { ours: { [canonical]: 10 }, theirs: { [canonical]: 20 } },
        );
        expect(result.value).toEqual(Option.some(theirs));
        expect(result.edits).toEqual({ [canonical]: 20 });
      });

      test("each conflicting path uses its own time", () => {
        const result = Merge.runDecided(
          authorTree({ excluded: new Set(), previouslyExcluded: new Set() }),
          {
            base: Option.some([entry("a", "base"), entry("b", "base")]),
            ours: Option.some([entry("a", "ours"), entry("b", "ours")]),
            theirs: Option.some([entry("a", "theirs"), entry("b", "theirs")]),
          },
          authorDecider({ ours: { a: 1, b: 4 }, theirs: { a: 2, b: 3 } }),
        );
        expect(result.value).toEqual(Option.some([entry("a", "theirs"), entry("b", "ours")]));
      });
      test("an overlap keeps the later observed edit", () => {
        const later = merge(
          [entry("a.md", "base")],
          [entry("a.md", "ours")],
          [entry("a.md", "theirs")],
          {},
          { ours: 1, theirs: 2 },
        );
        expect(later.value).toEqual(Option.some([entry("a.md", "theirs")]));
      });
    });
    describe("An edit wins over a conflicting deletion.", () => {
      test("an edit beats a deletion", () => {
        const deleted = merge(
          [entry("a.md", "base")],
          [],
          [entry("a.md", "theirs")],
          {},
          { ours: 5, theirs: 2 },
        );
        expect(deleted.value).toEqual(Option.some([entry("a.md", "theirs")]));
      });
    });
  });
});
