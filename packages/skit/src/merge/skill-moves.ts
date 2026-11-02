/**
 * Skill folders one side moved, so a three-way merge can line the other side's files up with
 * the new folder. Without this, renaming a skill on one device while editing it on another is a
 * deletion against an edit: the edit stays behind in a stub of the old folder and never reaches
 * the renamed skill.
 */
import { Array, Equal, Option, Order, TextDiff } from "effect";
import type { TreeFile } from "../artifact/tree-entry.js";
import { decodeUtf8 } from "../shared/text.js";

/** A skill folder and the folder one side moved it to. */
interface SkillMove {
  readonly from: string;
  readonly to: string;
}

/** A possible move and how alike the two folders are. */
interface ScoredMove extends SkillMove {
  readonly score: number;
}

/** Best match first; equal scores in folder order, so the result never depends on the device. */
const byScore = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (move: ScoredMove) => move.score),
  Order.mapInput(Order.String, (move: ScoredMove) => move.from),
);

const SKILL = "SKILL.md";

/** Folders holding a SKILL.md, excluding the workspace root. */
const skillFolders = (files: Readonly<Record<string, TreeFile>>) =>
  new Set(
    Object.keys(files)
      .filter((path) => path.endsWith(`/${SKILL}`))
      .map((path) => path.slice(0, -SKILL.length - 1)),
  );

/** The files under `folder`, keyed by their path inside it. */
const within = (files: Readonly<Record<string, TreeFile>>, folder: string) =>
  new Map(
    Object.entries(files)
      .filter(([path]) => path.startsWith(`${folder}/`))
      .map(([path, file]) => [path.slice(folder.length + 1), file] as const),
  );

/** Shared lines as a share of both texts, like git's rename similarity. */
const lineSimilarity = (left: string, right: string) => {
  const edits = TextDiff.lines(left, right);
  const count = (tag: string) =>
    edits.filter((edit) => edit._tag === tag).reduce((sum, edit) => sum + edit.items.length, 0);
  const equal = count("Equal");
  const total = 2 * equal + count("Delete") + count("Insert");
  return total === 0 ? 1 : (2 * equal) / total;
};

/**
 * How alike two skill folders are, from 0 to 1, or 0 when they cannot be the same skill: both
 * SKILL.md files must share at least half their lines, as git's rename detection requires, and
 * at least half the other files must be identical at the same place.
 */
const similarity = (before: Map<string, TreeFile>, after: Map<string, TreeFile>) => {
  const text = (files: Map<string, TreeFile>) =>
    Option.flatMap(Option.fromUndefinedOr(files.get(SKILL)), (file) => decodeUtf8(file.bytes));
  const skill = Option.getOrElse(
    Option.zipWith(text(before), text(after), lineSimilarity),
    () => 0,
  );
  if (skill < 0.5) return 0;
  const others = Array.dedupe([...before.keys(), ...after.keys()]).filter((path) => path !== SKILL);
  if (others.length === 0) return skill;
  const same = others.filter((path) =>
    Option.getOrElse(
      Option.zipWith(
        Option.fromUndefinedOr(before.get(path)),
        Option.fromUndefinedOr(after.get(path)),
        (left, right) => Equal.equals(left.bytes, right.bytes),
      ),
      () => false,
    ),
  );
  const files = same.length / others.length;
  return files < 0.5 ? 0 : (skill + files) / 2;
};

/** Skill folders that `side` removed and re-created elsewhere since `base`. */
const skillMoves = (
  base: Readonly<Record<string, TreeFile>>,
  side: Readonly<Record<string, TreeFile>>,
): ReadonlyArray<SkillMove> => {
  const [baseFolders, sideFolders] = [skillFolders(base), skillFolders(side)];
  const removed = [...baseFolders].filter((folder) => within(side, folder).size === 0);
  const added = [...sideFolders].filter((folder) => within(base, folder).size === 0);
  const candidates = Array.sort(
    removed
      .flatMap((from) =>
        added.map((to) => ({
          from,
          to,
          score: similarity(within(base, from), within(side, to)),
        })),
      )
      .filter((candidate) => candidate.score > 0),
    byScore,
  );
  // Each folder pairs once, best match first.
  return Array.reduce(candidates, Array.empty<SkillMove>(), (moves, { from, to }) =>
    moves.some((move) => move.from === from || move.to === to) ? moves : [...moves, { from, to }],
  );
};

/** Readonly<Record<string, TreeFile>> under each move's old folder, moved under its new one. A tree with files already there is left alone. */
const relocate = (
  files: Readonly<Record<string, TreeFile>>,
  moves: ReadonlyArray<SkillMove>,
): Readonly<Record<string, TreeFile>> => {
  const applicable = moves.filter((move) => within(files, move.to).size === 0);
  return Object.fromEntries(
    Object.entries(files).map(([path, file]) => {
      const move = applicable.find((candidate) => path.startsWith(`${candidate.from}/`));
      const destination = move === undefined ? path : `${move.to}${path.slice(move.from.length)}`;
      return [destination, destination === path ? file : { ...file, path: destination }];
    }),
  );
};

/**
 * The three trees with every detected skill move applied, so files line up by skill rather than
 * by old path. When both sides moved the same folder to different places, our move wins: the
 * device merging now breaks the tie.
 */
export const followSkillMoves = (trees: {
  base: Readonly<Record<string, TreeFile>>;
  ours: Readonly<Record<string, TreeFile>>;
  theirs: Readonly<Record<string, TreeFile>>;
}) => {
  const ours = skillMoves(trees.base, trees.ours);
  const theirsMoves = skillMoves(trees.base, trees.theirs);
  const theirs = theirsMoves.filter((move) => !ours.some((other) => other.from === move.from));
  // Both renamed one folder differently: their new folder follows our name too.
  const renamedTwice = theirsMoves.flatMap((move) =>
    ours
      .filter((other) => other.from === move.from && other.to !== move.to)
      .map((other) => ({ from: move.to, to: other.to })),
  );
  const moves = [...ours, ...theirs];
  return {
    base: relocate(trees.base, moves),
    ours: relocate(trees.ours, moves),
    theirs: relocate(trees.theirs, [...moves, ...renamedTwice]),
  };
};
