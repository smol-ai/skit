import { DateTime, Option } from "effect";
import { type History, mergeAuthorTree, Merge } from "@smolai/skit-core";

/**
 * Author sync's overlap rule: an edit beats a deletion, then the later edit wins, and this
 * device's version breaks a tie. It always decides, so an overlap never blocks sync.
 */
export const authorDecider = (editedAt: {
  readonly ours: DateTime.Utc;
  readonly theirs: DateTime.Utc;
}): Merge.Decider =>
  Merge.decide([Merge.present, Merge.latest((side) => Option.some(editedAt[side]))], "ours");

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
