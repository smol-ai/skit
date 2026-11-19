import { DateTime, Option } from "effect";
import { followSkillMoves } from "./merge/skill-moves.js";
import { mergeAuthorTree } from "./merge/files.js";
import * as History from "../history/history.js";
import * as Merge from "../sync/merge.js";
import type { TreeFile } from "../artifact/tree-entry.js";

/**
 * Author sync's overlap rule: an edit beats a deletion, then the later edit wins, and this
 * device's version breaks a tie. It always decides, so an overlap never blocks sync.
 */
export const authorDecider = (editedAt: {
  readonly ours: History.EditTimes;
  readonly theirs: History.EditTimes;
}): Merge.Decider =>
  Merge.decide(
    [
      Merge.present,
      Merge.latest((side, conflict) =>
        Option.map(
          Option.fromUndefinedOr(History.editTime(editedAt[side], String(conflict.at[0] ?? ""))),
          DateTime.makeUnsafe,
        ),
      ),
    ],
    "ours",
  );

/** Paths this device does not apply, now and as of its last sync. */
export interface Exclusions {
  readonly excluded: ReadonlySet<string>;
  readonly previouslyExcluded: ReadonlySet<string>;
}

/**
 * Trees merged as {@link mergeAuthorTree}, except that excluded paths never reach the merge: this
 * device neither applies nor replaces them, so the merged tree carries the Registry's copies
 * unchanged. A path excluded at the last sync is not in the base, so content that becomes visible
 * is an addition rather than a deletion.
 */
export const authorTree =
  ({ excluded, previouslyExcluded }: Exclusions): Merge.Merger<History.Tree> =>
  (versions, at, choose) => {
    const without = (paths: ReadonlySet<string>) => (side: Option.Option<History.Tree>) =>
      Option.map(side, (tree) => tree.filter((entry) => !paths.has(entry.path)));
    const merged = mergeAuthorTree(
      {
        base: without(new Set([...excluded, ...previouslyExcluded]))(versions.base),
        ours: without(excluded)(versions.ours),
        theirs: without(excluded)(versions.theirs),
      },
      at,
      choose,
    );
    const carried = Option.getOrElse(versions.theirs, () => []).filter((entry) =>
      excluded.has(entry.path),
    );
    return {
      ...merged,
      value: Option.map(merged.value, (tree) => [...tree, ...carried]),
    };
  };

/** File alignment and clock alignment are one operation: a rename must move both. */
export const mergeAuthorRevisions = (
  versions: Merge.Versions<History.Tree>,
  editedAt: { readonly ours: History.EditTimes; readonly theirs: History.EditTimes },
): Merge.Clean<History.Tree> & { readonly edits: History.EditTimes } => {
  const original = versions;
  if (
    [versions.base, versions.ours, versions.theirs].every((side) =>
      Option.getOrElse(side, () => []).every((entry) => entry.kind === "file"),
    )
  ) {
    const index = (side: Option.Option<History.Tree>, times: History.EditTimes) => {
      const tree: History.Tree = Option.getOrElse(side, () => []);
      const files = tree.filter((entry): entry is TreeFile => entry.kind === "file");
      return Object.fromEntries(
        files.map((entry) => [
          entry.path,
          { ...entry, editedAt: Object.hasOwn(times, entry.path) ? times[entry.path] : undefined },
        ]),
      );
    };
    const moved = followSkillMoves({
      base: index(versions.base, {}),
      ours: index(versions.ours, editedAt.ours),
      theirs: index(versions.theirs, editedAt.theirs),
    });
    const files = (side: typeof moved.ours) =>
      Object.values(side).map((entry) => ({
        kind: entry.kind,
        path: entry.path,
        mode: entry.mode,
        bytes: entry.bytes,
      }));
    const times = (side: typeof moved.ours) =>
      Object.fromEntries(
        Object.values(side).flatMap((entry) =>
          entry.editedAt === undefined ? [] : [[entry.path, entry.editedAt]],
        ),
      );
    versions = {
      base: Option.map(original.base, () => files(moved.base)),
      ours: Option.map(original.ours, () => files(moved.ours)),
      theirs: Option.map(original.theirs, () => files(moved.theirs)),
    };
    editedAt = { ours: times(moved.ours), theirs: times(moved.theirs) };
  }
  const merged = Merge.runDecided(
    authorTree({ excluded: new Set(), previouslyExcluded: new Set() }),
    versions,
    authorDecider(editedAt),
  );
  const tree = Option.getOrElse(merged.value, () => []);
  return {
    ...merged,
    edits: History.editTimes(
      tree,
      [
        { tree: Option.getOrElse(versions.ours, () => []), edits: editedAt.ours },
        { tree: Option.getOrElse(versions.theirs, () => []), edits: editedAt.theirs },
      ],
      0,
    ),
  };
};
