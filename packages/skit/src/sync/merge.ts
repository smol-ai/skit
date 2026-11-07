/**
 * Three-way merge of any value: combine two changed versions, `ours` and `theirs`, with the
 * `base` both started from.
 *
 * A {@link Merger} combines what each side changed. Where both changed the same thing
 * differently it asks a {@link Chooser}; a conflict no chooser decides leaves the merge without
 * a value, so nothing silently picks a side. Every decided conflict is kept as a {@link Choice}
 * with both versions, so a caller can always recover the side that lost.
 *
 * Absence is part of the value: `Option.none()` is a deleted or never-created value.
 */
import { Array, DateTime, Equivalence, Option, Order, Record, Struct, TextDiff } from "effect";

export type Side = "ours" | "theirs";

/** Where in the merged value: record keys, or 1-based line numbers in text. */
export type Path = ReadonlyArray<string | number>;

export interface Versions<A> {
  readonly base: Option.Option<A>;
  readonly ours: Option.Option<A>;
  readonly theirs: Option.Option<A>;
}

/** Both sides changed the same thing differently since the base. */
export interface Conflict<A = unknown> extends Versions<A> {
  readonly at: Path;
}

/** Picks the side a conflict keeps, or none to leave it undecided. */
export type Chooser = (conflict: Conflict) => Option.Option<Side>;

/** Picks the side a conflict keeps. Unlike a {@link Chooser}, it always decides. */
export type Decider = (conflict: Conflict) => Side;

/** A conflict a chooser decided, and the side it kept. */
export interface Choice {
  readonly conflict: Conflict;
  readonly kept: Side;
}

/** What a merger produces. While a conflict is undecided, the value holds `ours` for it. */
export interface Outcome<A> {
  readonly value: Option.Option<A>;
  readonly choices: ReadonlyArray<Choice>;
  readonly conflicts: ReadonlyArray<Conflict>;
}

export interface Merger<A> {
  (versions: Versions<A>, at: Path, choose: Chooser): Outcome<A>;
}

/** Every conflict decided: the merged value and each choice made on the way. */
export interface Clean<A> {
  readonly _tag: "Clean";
  readonly value: Option.Option<A>;
  readonly choices: ReadonlyArray<Choice>;
}

/** Conflicts the chooser left undecided. There is no merged value until they are decided. */
interface Conflicts<A> {
  readonly _tag: "Conflicts";
  readonly conflicts: Array.NonEmptyReadonlyArray<Conflict>;
  readonly choices: ReadonlyArray<Choice>;
  /** The merge itself, so {@link resolve} can decide the conflicts without the caller's help. */
  readonly merger: Merger<A>;
  readonly versions: Versions<A>;
}

export type Result<A> = Clean<A> | Conflicts<A>;

const clean = <A>(value: Option.Option<A>): Outcome<A> => ({ value, choices: [], conflicts: [] });

/** Ask the chooser; while undecided, carry on with `ours`. */
const conflict = <A>(versions: Versions<A>, at: Path, choose: Chooser): Outcome<A> => {
  const found: Conflict<A> = { ...versions, at };
  return Option.match(choose(found), {
    onNone: () => ({ value: versions.ours, choices: [], conflicts: [found] }),
    onSome: (kept) => ({
      value: kept === "ours" ? versions.ours : versions.theirs,
      choices: [{ conflict: found, kept }],
      conflicts: [],
    }),
  });
};

/**
 * A merger from the rules every merger shares: a side that did not change takes the other, and
 * a deletion against an edit is a conflict. Only two present, different changes reach `both`.
 */
export const make =
  <A>(
    equivalence: Equivalence.Equivalence<A>,
    both: (base: Option.Option<A>, ours: A, theirs: A, at: Path, choose: Chooser) => Outcome<A>,
  ): Merger<A> =>
  (versions, at, choose) => {
    const same = Option.makeEquivalence(equivalence);
    const { base, ours, theirs } = versions;
    if (same(ours, theirs)) return clean(ours);
    if (same(base, ours)) return clean(theirs);
    if (same(base, theirs)) return clean(ours);
    if (Option.isNone(ours) || Option.isNone(theirs)) return conflict(versions, at, choose);
    return both(base, ours.value, theirs.value, at, choose);
  };

/** An indivisible value: two different changes always conflict. */
export const whole = <A>(equivalence: Equivalence.Equivalence<A>): Merger<A> =>
  make(equivalence, (base, ours, theirs, at, choose) =>
    conflict({ base, ours: Option.some(ours), theirs: Option.some(theirs) }, at, choose),
  );

/** Collect what several mergers produced into one outcome. */
const combine = <A>(value: Option.Option<A>, parts: ReadonlyArray<Outcome<unknown>>) => ({
  value,
  choices: parts.flatMap((part) => part.choices),
  conflicts: parts.flatMap((part) => part.conflicts),
});

/**
 * Merge each key on its own with `merger`, or with the merger `overrides` names for that key.
 * A missing key is an absent value.
 */
export const record =
  <A>(
    merger: Merger<A>,
    overrides: Readonly<Record<string, Merger<A>>> = {},
  ): Merger<Readonly<Record<string, A>>> =>
  (versions, at, choose) => {
    const keys = Array.sort(
      Array.dedupe(
        [versions.base, versions.ours, versions.theirs].flatMap((side) =>
          Option.match(side, { onNone: () => [], onSome: Record.keys }),
        ),
      ),
      Order.String,
    );
    const merged = keys.map((key) => {
      const side = (values: Option.Option<Readonly<Record<string, A>>>) =>
        Option.flatMap(values, Record.get(key));
      const forKey = Option.getOrElse(Record.get(overrides, key), () => merger);
      const outcome = forKey(
        { base: side(versions.base), ours: side(versions.ours), theirs: side(versions.theirs) },
        [...at, key],
        choose,
      );
      return [key, outcome] as const;
    });
    // Absent on both sides and in the result: keep it absent rather than an empty record.
    const absent =
      Option.isNone(versions.ours) && Option.isNone(versions.theirs) && keys.length === 0;
    return combine(
      absent
        ? Option.none()
        : Option.some(
            Record.getSomes(
              Record.fromEntries(merged.map(([key, outcome]) => [key, outcome.value] as const)),
            ),
          ),
      merged.map(([, outcome]) => outcome),
    );
  };

/** A value with a fixed set of fields, each merged with its own merger. */
export const struct =
  <A extends object>(fields: {
    readonly [K in keyof A]: Merger<A[K]>;
  }): Merger<A> =>
  (versions, at, choose) => {
    const merged = Struct.keys(fields).map((key) => {
      const outcome = fields[key](
        {
          base: Option.map(versions.base, Struct.get(key)),
          ours: Option.map(versions.ours, Struct.get(key)),
          theirs: Option.map(versions.theirs, Struct.get(key)),
        },
        [...at, key],
        choose,
      );
      return [key, outcome] as const;
    });
    const value = Record.getSomes(
      Record.fromEntries(merged.map(([key, outcome]) => [key, outcome.value] as const)),
    );
    return combine(
      Option.isNone(versions.ours) && Option.isNone(versions.theirs)
        ? Option.none()
        : // The fields of A, each merged; TypeScript cannot follow a mapped object back to A.
          Option.some(value as A),
      merged.map(([, outcome]) => outcome),
    );
  };

/**
 * A list treated as a set: both sides' additions are kept and removals honoured, so the sides
 * never conflict. Order follows `ours`, then the additions from `theirs`.
 */
export const set =
  <A>(equivalence: Equivalence.Equivalence<A>): Merger<ReadonlyArray<A>> =>
  (versions) => {
    const has = (items: ReadonlyArray<A>, item: A) =>
      items.some((other) => equivalence(other, item));
    const base = Option.getOrElse(versions.base, Array.empty);
    const ours = Option.getOrElse(versions.ours, Array.empty);
    const theirs = Option.getOrElse(versions.theirs, Array.empty);
    const removed = (items: ReadonlyArray<A>) => base.filter((item) => !has(items, item));
    const oursRemoved = removed(ours);
    const theirsRemoved = removed(theirs);
    const merged = [
      ...ours.filter((item) => !has(theirsRemoved, item)),
      ...theirs.filter((item) => !has(ours, item) && !has(base, item)),
    ].filter((item) => !has(oursRemoved, item));
    const absent = Option.isNone(versions.ours) && Option.isNone(versions.theirs);
    return clean(absent && merged.length === 0 ? Option.none() : Option.some(merged));
  };

/**
 * A value merged through another shape: decode every side, merge, then encode, given `ours` as
 * it decoded so the encoding can keep its formatting. The decoded value may carry more than the
 * merger reads. When any side does not decode, `fallback` merges instead.
 */
export const via =
  <A, B, D extends B = B>(
    codec: {
      readonly decode: (value: A) => Option.Option<D>;
      readonly encode: (merged: B, ours: D) => A;
    },
    merger: Merger<B>,
    fallback: Merger<A>,
  ): Merger<A> =>
  (versions, at, choose) => {
    const base = Option.map(versions.base, codec.decode);
    const ours = Option.flatMap(versions.ours, codec.decode);
    const theirs = Option.map(versions.theirs, codec.decode);
    if (
      Option.isNone(ours) ||
      Option.exists(base, Option.isNone) ||
      Option.exists(theirs, Option.isNone)
    )
      return fallback(versions, at, choose);
    const merged = merger(
      { base: Option.flatten(base), ours, theirs: Option.flatten(theirs) },
      at,
      choose,
    );
    return {
      ...merged,
      value: Option.map(merged.value, (value) => codec.encode(value, ours.value)),
    };
  };

/** One run of base lines `[start, end)` replaced by `lines`, as one side changed it. */
interface Change {
  readonly side: Side;
  readonly start: number;
  readonly end: number;
  readonly lines: ReadonlyArray<string>;
}

/** Lines with their terminators, the way TextDiff.lines splits them. */
const splitLines = (text: string): ReadonlyArray<string> => text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];

const changes = (side: Side, base: string, changed: string): ReadonlyArray<Change> => {
  const found: Change[] = [];
  let at = 0;
  let pending: { start: number; end: number; lines: string[] } | undefined;
  const flush = () => {
    if (pending !== undefined) found.push({ side, ...pending });
    pending = undefined;
  };
  for (const edit of TextDiff.lines(base, changed)) {
    if (edit._tag === "Equal") {
      flush();
      at += edit.items.length;
      continue;
    }
    pending ??= { start: at, end: at, lines: [] };
    if (edit._tag === "Delete") {
      at += edit.items.length;
      pending.end = at;
    } else pending.lines.push(...edit.items);
  }
  flush();
  return found;
};

/**
 * Changes whose base ranges intersect overlap. An insertion overlaps a change only when it
 * lands strictly inside it, or at the same point as another insertion; adjacent changed lines
 * never overlap.
 */
const clusters = (all: ReadonlyArray<Change>): ReadonlyArray<ReadonlyArray<Change>> => {
  const sorted = [...all].sort((left, right) => left.start - right.start || left.end - right.end);
  const grouped: Change[][] = [];
  let start = 0;
  let end = -1;
  for (const change of sorted) {
    const current = grouped.at(-1);
    const joins =
      current !== undefined &&
      (change.start < end ||
        (change.start === change.end && start === end && change.start === start));
    if (joins) {
      current.push(change);
      end = Math.max(end, change.end);
    } else {
      grouped.push([change]);
      start = change.start;
      end = change.end;
    }
  }
  return grouped;
};

/** The base lines `[start, end)` with one side's changes applied. */
const region = (
  baseLines: ReadonlyArray<string>,
  start: number,
  end: number,
  changes: ReadonlyArray<Change>,
) => {
  const out: string[] = [];
  let at = start;
  for (const change of changes) {
    out.push(...baseLines.slice(at, change.start), ...change.lines);
    at = change.end;
  }
  out.push(...baseLines.slice(at, end));
  return out.join("");
};

const line = whole(Equivalence.String);

/**
 * Text merged line by line (diff3). Changes to different lines combine; each overlapping region
 * is a conflict of its own, so one conflict never discards the other side's other edits. Text
 * with no base is one indivisible value.
 */
export const lines: Merger<string> = make(Equivalence.String, (base, ours, theirs, at, choose) => {
  if (Option.isNone(base))
    return conflict({ base, ours: Option.some(ours), theirs: Option.some(theirs) }, at, choose);
  const baseLines = splitLines(base.value);
  const out: string[] = [];
  const parts: Outcome<string>[] = [];
  let next = 0;
  for (const cluster of clusters([
    ...changes("ours", base.value, ours),
    ...changes("theirs", base.value, theirs),
  ])) {
    const start = Math.min(...cluster.map((change) => change.start));
    const end = Math.max(...cluster.map((change) => change.end));
    out.push(...baseLines.slice(next, start));
    next = end;
    const side = (name: Side) =>
      region(
        baseLines,
        start,
        end,
        cluster.filter((change) => change.side === name),
      );
    const [oursRegion, theirsRegion] = [side("ours"), side("theirs")];
    if (oursRegion === theirsRegion || cluster.every((change) => change.side === "ours")) {
      out.push(oursRegion);
      continue;
    }
    if (cluster.every((change) => change.side === "theirs")) {
      out.push(theirsRegion);
      continue;
    }
    const baseRegion = baseLines.slice(start, end);
    const [oursLines, theirsLines] = [splitLines(oursRegion), splitLines(theirsRegion)];
    // Same-length edits of neighbouring lines diff as one block; decide them line by line so a
    // change to one line never discards the other side's change to the next.
    const pairs =
      oursLines.length === baseRegion.length && theirsLines.length === baseRegion.length
        ? Array.zip(baseRegion, Array.zip(oursLines, theirsLines)).map(
            ([text, [oursLine, theirsLine]], index) => ({
              base: text,
              ours: oursLine,
              theirs: theirsLine,
              line: start + index + 1,
            }),
          )
        : [{ base: baseRegion.join(""), ours: oursRegion, theirs: theirsRegion, line: start + 1 }];
    for (const pair of pairs) {
      const merged = line(
        {
          base: Option.some(pair.base),
          ours: Option.some(pair.ours),
          theirs: Option.some(pair.theirs),
        },
        [...at, pair.line],
        choose,
      );
      out.push(Option.getOrElse(merged.value, () => ""));
      parts.push(merged);
    }
  }
  out.push(...baseLines.slice(next));
  return combine(Option.some(out.join("")), parts);
});

/**
 * Merge `ours` and `theirs` from `base`. With no chooser nothing is decided, so any conflict
 * leaves the result without a value.
 */
export const run = <A>(
  merger: Merger<A>,
  versions: Versions<A>,
  choose: Chooser = undecided,
): Result<A> => {
  const outcome = merger(versions, [], choose);
  return Array.isReadonlyArrayNonEmpty(outcome.conflicts)
    ? {
        _tag: "Conflicts",
        conflicts: outcome.conflicts,
        choices: outcome.choices,
        merger,
        versions,
      }
    : { _tag: "Clean", value: outcome.value, choices: outcome.choices };
};

/** Merge with every conflict decided by `decide`, so the result is always clean. */
export const runDecided = <A>(
  merger: Merger<A>,
  versions: Versions<A>,
  decide: Decider,
): Clean<A> => {
  const outcome = merger(versions, [], (found) => Option.some(decide(found)));
  return { _tag: "Clean", value: outcome.value, choices: outcome.choices };
};

/** Decide a result's conflicts with `choose`; whatever it leaves undecided stays a conflict. */
export const resolve = <A>(result: Result<A>, choose: Chooser): Result<A> =>
  result._tag === "Clean" ? result : run(result.merger, result.versions, choose);

/** Decides nothing. */
export const undecided: Chooser = () => Option.none();

/** Always keeps the same side. */
export const always =
  (side: Side): Chooser =>
  () =>
    Option.some(side);

/** An edit beats a deletion, whichever happened later. */
export const present: Chooser = ({ ours, theirs }) =>
  Option.isSome(ours) && Option.isNone(theirs)
    ? Option.some("ours")
    : Option.isNone(ours) && Option.isSome(theirs)
      ? Option.some("theirs")
      : Option.none();

/**
 * The side edited later wins. `editedAt` says when a side last edited the conflict's place;
 * abstains when either time is unknown or both are equal.
 */
export const latest =
  (editedAt: (side: Side, conflict: Conflict) => Option.Option<DateTime.Utc>): Chooser =>
  (found) =>
    Option.flatMap(
      Option.zipWith(editedAt("ours", found), editedAt("theirs", found), DateTime.Order),
      (order): Option.Option<Side> =>
        order > 0 ? Option.some("ours") : order < 0 ? Option.some("theirs") : Option.none(),
    );

/** The first chooser that decides. */
export const prefer =
  (...choosers: ReadonlyArray<Chooser>): Chooser =>
  (found) =>
    Array.findFirst(choosers, (choose) => choose(found));

/** The first of `choosers` that decides, or else `otherwise`. */
export const decide =
  (choosers: ReadonlyArray<Chooser>, otherwise: Side): Decider =>
  (found) =>
    Option.getOrElse(prefer(...choosers)(found), () => otherwise);
