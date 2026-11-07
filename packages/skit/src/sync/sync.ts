/**
 * Synchronizing a device's tree with a SKIT on the Registry: a pure {@link plan} and one
 * interpreter, {@link run}, that performs every write.
 *
 * The device keeps one {@link SyncState} per SKIT. `Idle { base }` means the device's files
 * descend from `base`, a revision that was current on the Registry. `Sending { base, revision }`
 * means the device recorded `revision` on top of `base`, holds its files, and was moving the
 * Registry's `current` from `base` to it when it last stopped; it may not know whether the move
 * landed. `Writing` names both trees of an unfinished file write and the state to save when it
 * finishes. Files already written are not new authored edits when the device restarts.
 *
 * Nothing here knows about HTTP or the filesystem. The caller passes the Registry as a
 * {@link Remote} and the device's history as a {@link History.Store}, plain values, and saves the
 * state and writes files through callbacks, in an order that keeps every step recoverable:
 *
 * - every revision is posted before `current` can point at it, and posting never moves it;
 * - the state names the revision being sent before the move, so an unknown outcome is retried;
 * - Writing is saved before files change, and stays saved until the write finishes.
 */
import { Clock, DateTime, Effect, Option, Schema, Stream } from "effect";
import * as History from "../history/history.js";
import * as Merge from "./merge.js";
import { TreeEntry } from "../artifact/tree-entry.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { parentDirectories } from "../shared/relative-path.js";

export const Idle = Schema.TaggedStruct("Idle", { base: Schema.NullOr(History.RevisionId) });
export const Sending = Schema.TaggedStruct("Sending", {
  base: Schema.NullOr(History.RevisionId),
  revision: History.RevisionId,
});
export const Writing = Schema.TaggedStruct("Writing", {
  /** The ancestor of edits made after this write started. */
  base: Schema.NullOr(History.RevisionId),
  from: History.TreeHash,
  to: History.TreeHash,
  next: Schema.Union([Schema.Struct({ ...Idle.fields, base: History.RevisionId }), Sending]),
  /** The write applies a merge, so a resumed run still reports "merged" (A12). */
  merged: Schema.Boolean,
});
export const SyncState = Schema.Union([Idle, Sending, Writing]);
export type SyncState = typeof SyncState.Type;

const sameState = Schema.toEquivalence(SyncState);

/**
 * Whether {@link run} ever saves `to` right after `from`. `Idle { base: null }` is where a SKIT
 * starts, never a step. An unfinished write only finishes into the state it names, or is
 * prepared again for a different tree with the same base and next state (the recovered merge).
 */
export const allowsStep = (from: SyncState, to: SyncState): boolean => {
  if (to._tag === "Idle" && to.base === null) return false;
  if (from._tag !== "Writing") return true;
  return (
    sameState(to, from.next) ||
    (to._tag === "Writing" && to.base === from.base && sameState(to.next, from.next))
  );
};

/**
 * Files the device deleted since its base: how many, out of how many it knew, and which. Too many
 * at once blocks sync until the same value is passed back as approval.
 */
export const Removal = Schema.Struct({
  deleting: Schema.Int,
  of: Schema.Int,
  paths: Schema.Array(Schema.String),
});
export type Removal = typeof Removal.Type;

/** Another device moved `current` first. */
export class Moved extends Schema.TaggedError<Moved, { readonly brand: unique symbol }>()(
  "Sync.Moved",
  {
    current: Schema.NullOr(History.RevisionId),
  },
) {}

/** The Registry sent a revision or tree that does not match its identity. */
class RemoteInvalid
  extends Schema.TaggedError<RemoteInvalid, { readonly brand: unique symbol }>()(
    "Sync.RemoteInvalid",
    {
      id: History.RevisionId,
      reason: Schema.String,
    },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get message() {
    return `The Registry sent revision ${this.id} in a form that does not match it: ${this.reason}`;
  }
  readonly remediation = "Sync again; if it keeps failing, report the Registry's response.";
}

class InvalidTree
  extends Schema.TaggedError<InvalidTree, { readonly brand: unique symbol }>()("Sync.InvalidTree", {
    path: Schema.String,
    message: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Keep the local files and history; report this invalid sync tree.";
}

const checkTree = (tree: History.Tree) => {
  const issue = History.treePathIssue(tree);
  return issue === undefined ? Effect.void : Effect.fail(new InvalidTree(issue));
};

/** Other devices kept moving `current` while this one tried to sync. */
class Unsettled
  extends Schema.TaggedError<Unsettled, { readonly brand: unique symbol }>()("Sync.Unsettled", {
    steps: Schema.Int,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly retryable = true;
  get message() {
    return `Sync did not settle after ${this.steps} steps while other devices kept changing the SKIT`;
  }
  readonly remediation = "Sync again; nothing was lost.";
}

/** A revision with its tree. */
export interface LoadedRevision {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly tree: History.Tree;
}

/**
 * The Registry's side of one SKIT. Failures other than {@link Moved} are the caller's own. A plain
 * value: the caller builds one per sync from its Registry client.
 */
export interface Remote {
  readonly current: Effect.Effect<History.RevisionId | null, SkitFailure>;
  readonly revision: (
    id: History.RevisionId,
  ) => Effect.Effect<
    { readonly revision: History.Revision; readonly tree: History.Tree },
    SkitFailure
  >;
  /** Revisions reachable from `id`, starting there, without their trees. */
  readonly ancestors: (
    id: History.RevisionId,
  ) => Stream.Stream<
    { readonly id: History.RevisionId; readonly revision: History.Revision },
    SkitFailure
  >;
  /** Record a revision. Idempotent; never moves `current`. */
  readonly post: (
    id: History.RevisionId,
    revision: History.Revision,
    tree: History.Tree,
  ) => Effect.Effect<void, SkitFailure>;
  /** Point `current` at `id`, only if it still points at `expected`. */
  readonly move: (
    expected: History.RevisionId | null,
    id: History.RevisionId,
  ) => Effect.Effect<void, Moved | SkitFailure>;
}

/**
 * What {@link plan} decides from: the device's tree, the revisions its state names, and the
 * Registry's `current`. A `Sending` input always holds the revision being sent.
 */
export type PlanInput =
  | {
      readonly _tag: "Writing";
      readonly state: typeof Writing.Type;
      readonly local: { readonly hash: History.TreeHash; readonly tree: History.Tree };
      readonly from: History.Tree;
      readonly to: History.Tree;
    }
  | {
      readonly _tag: "Idle";
      readonly local: { readonly hash: History.TreeHash; readonly tree: History.Tree };
      readonly base: LoadedRevision | null;
      readonly current: LoadedRevision | null;
    }
  | {
      readonly _tag: "Sending";
      readonly local: { readonly hash: History.TreeHash; readonly tree: History.Tree };
      readonly base: LoadedRevision | null;
      readonly sent: LoadedRevision;
      readonly current: LoadedRevision | null;
    };

/**
 * The revision this device sends: its local tree recorded on top of `parents`, or a revision it
 * already recorded and posted.
 */
type LocalRevision =
  | { readonly _tag: "Local"; readonly parents: ReadonlyArray<History.RevisionId> }
  | { readonly _tag: "Sent"; readonly sent: LoadedRevision };

export type Plan =
  | { readonly _tag: "Write"; readonly input: Extract<PlanInput, { readonly _tag: "Writing" }> }
  /** The device's files are `base`'s tree. */
  | { readonly _tag: "UpToDate"; readonly base: History.RevisionId }
  /** Only the Registry changed: write `current`'s tree. */
  | { readonly _tag: "Pull"; readonly current: LoadedRevision }
  /** Only the device changed: move `current` from `expected` to ours. */
  | {
      readonly _tag: "Push";
      readonly ours: LocalRevision;
      readonly expected: History.RevisionId | null;
    }
  /** Both changed since `base`: merge ours with theirs, the Registry's `current`. */
  | {
      readonly _tag: "Merge";
      readonly base: LoadedRevision | null;
      readonly ours: LocalRevision;
      readonly theirs: LoadedRevision;
    }
  | { readonly _tag: "Blocked"; readonly removal: Removal };

/** Files and symlinks are what an author knows; a directory is only where they live. */
const knownPaths = (tree: History.Tree) =>
  tree.filter((entry) => entry.kind !== "directory").map((entry) => entry.path);

/**
 * Decide the next step. Pure: everything it needs is in `input`. A push or merge that deletes too
 * many of the base's files, as ADR-0026 defines bulk removal (every known file, or more than five
 * and more than half), is `Blocked` unless `approved` is that exact removal.
 */
export const plan = (input: PlanInput, approved?: Removal): Plan => {
  if (input._tag === "Writing") return { _tag: "Write", input };
  const current = input.current;
  if (input._tag === "Sending") {
    const sent = input.sent;
    // The move landed: the device holds `sent`, so plan from there.
    if (current?.id === sent.id)
      return plan({ _tag: "Idle", local: input.local, base: sent, current }, approved);
    // The move never landed. Removal safety was decided when the revision was first planned.
    if (current === null || current.id === input.base?.id)
      return { _tag: "Push", ours: { _tag: "Sent", sent }, expected: current?.id ?? null };
    // Someone else moved first. Merge what the device holds now, which descends from `sent`.
    const ours: LocalRevision =
      input.local.hash === sent.revision.tree
        ? { _tag: "Sent", sent }
        : { _tag: "Local", parents: [sent.id] };
    return { _tag: "Merge", base: input.base, ours, theirs: current };
  }
  const base = input.base;
  const guarded = (next: Plan): Plan => {
    if (base === null) return next;
    const kept = new Set(knownPaths(input.local.tree));
    const known = knownPaths(base.tree);
    const paths = known.filter((path) => !kept.has(path)).sort();
    const removal = { deleting: paths.length, of: known.length, paths };
    const bulk =
      removal.deleting > 0 &&
      (removal.deleting === removal.of ||
        (removal.deleting > 5 && removal.deleting > removal.of / 2));
    return bulk && !(approved !== undefined && Schema.toEquivalence(Removal)(removal, approved))
      ? { _tag: "Blocked", removal }
      : next;
  };
  if (current === null)
    return guarded({ _tag: "Push", ours: { _tag: "Local", parents: [] }, expected: null });
  if (current.revision.tree === input.local.hash) return { _tag: "UpToDate", base: current.id };
  // Never synced. An empty device takes the SKIT; otherwise nothing is known to be deleted, so
  // merging keeps both sides' files.
  if (base === null)
    return input.local.tree.length === 0
      ? { _tag: "Pull", current }
      : { _tag: "Merge", base: null, ours: { _tag: "Local", parents: [] }, theirs: current };
  if (current.id === base.id)
    return guarded({
      _tag: "Push",
      ours: { _tag: "Local", parents: [base.id] },
      expected: base.id,
    });
  if (input.local.hash === base.revision.tree) return { _tag: "Pull", current };
  return guarded({
    _tag: "Merge",
    base,
    ours: { _tag: "Local", parents: [base.id] },
    theirs: current,
  });
};

/** A revision from the device's store, with its tree. */
const loadRevision = Effect.fn("Sync.loadRevision")(function* (
  store: History.Store,
  id: History.RevisionId,
) {
  const revision = yield* store.revision(id);
  return { id, revision, tree: yield* store.tree(revision.tree) } satisfies LoadedRevision;
});

/**
 * What {@link plan} needs: the state's revisions from the device's store, and `current` from the
 * Registry, beside the device's tree. A `current` the device does not hold yet is fetched, checked
 * against its identity, and stored shallowly.
 */
export const loadPlanInput = Effect.fn("Sync.loadPlanInput")(function* ({
  store,
  remote,
  state,
  local,
}: {
  /** The device's history. */
  readonly store: History.Store;
  /** The Registry's side of the SKIT. */
  readonly remote: Remote;
  readonly state: SyncState;
  /** The device's tree. */
  readonly local: { readonly hash: History.TreeHash; readonly tree: History.Tree };
}): Effect.fn.Return<PlanInput, History.StoreError | SkitFailure> {
  if (state._tag === "Writing") {
    const from = yield* store.tree(state.from);
    const to = yield* store.tree(state.to);
    yield* checkTree(from);
    yield* checkTree(to);
    return {
      _tag: "Writing",
      state,
      local,
      from,
      to,
    };
  }
  const currentId = yield* remote.current;
  const current =
    currentId === null
      ? null
      : yield* loadRevision(store, currentId).pipe(
          Effect.catchTag("History.StoreMissing", () =>
            Effect.gen(function* () {
              const fetched = yield* remote.revision(currentId);
              if ((yield* store.putTree(fetched.tree)) !== fetched.revision.tree)
                return yield* new RemoteInvalid({
                  id: currentId,
                  reason: "its tree does not match the revision",
                });
              if ((yield* store.commit(fetched.revision)) !== currentId)
                return yield* new RemoteInvalid({
                  id: currentId,
                  reason: "its identity does not match",
                });
              return yield* loadRevision(store, currentId);
            }),
          ),
        );
  if (current !== null) yield* checkTree(current.tree);
  const common = {
    local,
    base: state.base === null ? null : yield* loadRevision(store, state.base),
    current,
  };
  if (state._tag === "Idle") return { _tag: "Idle", ...common };
  const sent = yield* loadRevision(store, state.revision);
  // Another device may have built on the send after it landed. Then the device holds an ancestor
  // of `current`, and must plan from what it sent rather than merge it again.
  const landed =
    current !== null &&
    current.id !== sent.id &&
    current.id !== state.base &&
    Option.isSome(
      yield* remote.ancestors(current.id).pipe(
        Stream.filter((entry) => entry.id === sent.id),
        Stream.runHead,
      ),
    );
  return landed ? { _tag: "Idle", ...common, base: sent } : { _tag: "Sending", ...common, sent };
});

/**
 * When a revision's content was last edited, in milliseconds. An edit was made when it was
 * recorded; a merge was not authored at one time, so it is as recent as its latest parent. Unknown
 * while a parent is missing from `known`.
 */
const lastEdit = (
  known: ReadonlyMap<History.RevisionId, History.Revision>,
  id: History.RevisionId,
): Option.Option<number> =>
  Option.flatMap(Option.fromUndefinedOr(known.get(id)), (revision) =>
    revision.parents.length < 2
      ? Option.some(revision.author.at)
      : Option.map(Option.all(revision.parents.map((parent) => lastEdit(known, parent))), (times) =>
          Math.max(...times),
        ),
  );

/** {@link lastEdit} for a revision, reading a merge's ancestry from the Registry as needed. */
const editedAt = Effect.fn("Sync.editedAt")(function* (remote: Remote, start: LoadedRevision) {
  if (start.revision.parents.length < 2) return DateTime.makeUnsafe(start.revision.author.at);
  const known = yield* remote.ancestors(start.id).pipe(
    Stream.scan(
      (): ReadonlyMap<History.RevisionId, History.Revision> => new Map(),
      (known, entry) => new Map(known).set(entry.id, entry.revision),
    ),
    Stream.takeUntil((known) => Option.isSome(lastEdit(known, start.id))),
    Stream.runLast,
  );
  // An incomplete history leaves only the merge's own time.
  return DateTime.makeUnsafe(
    Option.getOrElse(
      Option.flatMap(known, (found) => lastEdit(found, start.id)),
      () => start.revision.author.at,
    ),
  );
});

type Outcome =
  | { readonly status: "up_to_date"; readonly revision: History.RevisionId }
  | {
      readonly status: "pulled";
      readonly revision: History.RevisionId;
      /** Paths whose files sync wrote or removed. */
      readonly paths: ReadonlyArray<string>;
    }
  | { readonly status: "pushed"; readonly revision: History.RevisionId }
  | {
      readonly status: "merged";
      readonly revision: History.RevisionId;
      readonly paths: ReadonlyArray<string>;
      /** Every conflict the merges decided, with the side each kept. */
      readonly choices: ReadonlyArray<Merge.Choice>;
    }
  | { readonly status: "blocked"; readonly removal: Removal };

export interface RunOptions<Prepared, SaveError, WriteError, R> {
  /** The device's history, where the engine records revisions and stores trees it fetched. */
  readonly store: History.Store;
  /** The Registry's side of the SKIT. */
  readonly remote: Remote;
  readonly state: SyncState;
  /** The device's tree, already in its store. */
  readonly local: History.TreeHash;
  /** Who records the device's revision: this device, and when it first saw its files. */
  readonly author: History.Author;
  /** How trees merge. */
  readonly merger: Merge.Merger<History.Tree>;
  /** The rule that decides every conflict, given when each side last edited. */
  readonly decide: (editedAt: {
    readonly ours: DateTime.Utc;
    readonly theirs: DateTime.Utc;
  }) => Merge.Decider;
  /** A removal the user approved; it applies only if the removal is exactly this one. */
  readonly approved?: Removal;
  /** Save the state durably before returning. Every step but the one into Writing. */
  readonly save: (
    state: Exclude<SyncState, { readonly _tag: "Writing" }>,
  ) => Effect.Effect<void, SaveError, R>;
  /**
   * Save a Writing durably before returning, and return what proves it was saved. The engine
   * hands that to the one {@link RunOptions.write} the Writing names.
   */
  readonly prepareWrite: (state: typeof Writing.Type) => Effect.Effect<Prepared, SaveError, R>;
  /** Make the device's files `to`, if they are still `from`, under the Writing `prepared` saved. */
  readonly write: (
    prepared: Prepared,
    from: History.Tree,
    to: History.Tree,
  ) => Effect.Effect<void, WriteError, R>;
}

export interface RunResult {
  readonly state: SyncState;
  readonly outcome: Outcome;
}

/** How many steps sync may take, including retries after another device moves first. */
const MAX_STEPS = 8;

/** What sync has done so far. Statuses are in order of strength. */
interface Progress {
  readonly state: SyncState;
  readonly local: { readonly hash: History.TreeHash; readonly tree: History.Tree };
  readonly status: "up_to_date" | "pulled" | "pushed" | "merged";
  readonly choices: ReadonlyArray<Merge.Choice>;
}
const strength = ["up_to_date", "pulled", "pushed", "merged"] as const;

/**
 * A write replaces one whole entry at a time. An entry matching either end is pending or
 * already written; anything else is an edit made since. Recover the authored input without
 * partly downloaded entries, so it keeps its original ancestry before merging the pending write.
 */
const authoredTree = (input: Extract<PlanInput, { readonly _tag: "Writing" }>) => {
  const from = new Map(input.from.map((entry) => [entry.path, entry]));
  const to = new Map(input.to.map((entry) => [entry.path, entry]));
  const local = new Map(input.local.tree.map((entry) => [entry.path, entry]));
  const same = Option.makeEquivalence(Schema.toEquivalence(TreeEntry));
  const authored: TreeEntry[] = [];
  const edits: TreeEntry[] = [];
  for (const path of new Set([...from.keys(), ...to.keys(), ...local.keys()])) {
    const before = Option.fromUndefinedOr(from.get(path));
    const after = Option.fromUndefinedOr(to.get(path));
    const current = Option.fromUndefinedOr(local.get(path));
    const edited = !same(current, before) && !same(current, after);
    if (edited && Option.isSome(current)) edits.push(current.value);
    const input = edited ? current : before;
    if (Option.isSome(input)) authored.push(input.value);
  }
  // A real structural edit replaces its implicit parents/descendants too. Do not resurrect
  // an original file beside the editor's new children while undoing downloaded progress.
  const parents = new Set(edits.flatMap((edit) => parentDirectories(edit.path)));
  const leaves = new Set(
    edits.filter((edit) => edit.kind !== "directory").map((edit) => edit.path),
  );
  return History.sortTree(
    authored.filter(
      (entry) =>
        (entry.kind === "directory" || !parents.has(entry.path)) &&
        !parentDirectories(entry.path).some((parent) => leaves.has(parent)),
    ),
  );
};

/**
 * Plan and perform steps until the device and the Registry agree or sync is blocked. A lost race
 * re-reads `current` and plans again. Returns the state it last saved and what happened, with the
 * strongest status of any step: merged, then pushed, then pulled.
 */
export const run = <Prepared, SaveError, WriteError, R>(
  options: RunOptions<Prepared, SaveError, WriteError, R>,
): Effect.Effect<RunResult, SaveError | WriteError | History.StoreError | SkitFailure, R> =>
  Effect.fn("Sync.run")(function* () {
    const { store, remote } = options;
    const start = { hash: options.local, tree: yield* store.tree(options.local) };
    yield* checkTree(start.tree);
    // A send whose outcome is unknown is posted again first, so every later step may rely on it.
    if (options.state._tag === "Sending") {
      const sent = yield* loadRevision(store, options.state.revision);
      yield* remote.post(sent.id, sent.revision, sent.tree);
    }

    const send = Effect.fn("Sync.send")(function* (ours: LocalRevision, local: History.Tree) {
      if (ours._tag === "Sent") return ours.sent;
      const recorded = yield* History.record(store, local, ours.parents, options.author);
      yield* remote.post(recorded.id, recorded.revision, local);
      return { ...recorded, tree: local } satisfies LoadedRevision;
    });
    const moved = (expected: History.RevisionId | null, id: History.RevisionId) =>
      remote.move(expected, id).pipe(
        Effect.as(true),
        Effect.catchTag("Sync.Moved", () => Effect.succeed(false)),
      );
    const stronger = (progress: Progress, status: Progress["status"]) =>
      strength.indexOf(status) > strength.indexOf(progress.status) ? status : progress.status;
    const saved = <S extends Exclude<SyncState, { readonly _tag: "Writing" }>>(state: S) =>
      options.save(state).pipe(Effect.as(state));

    const step = (
      progress: Progress,
      steps: number,
    ): Effect.Effect<RunResult, SaveError | WriteError | History.StoreError | SkitFailure, R> =>
      Effect.gen(function* () {
        if (steps === MAX_STEPS) return yield* new Unsettled({ steps });
        const next = plan(
          yield* loadPlanInput({ store, remote, state: progress.state, local: progress.local }),
          options.approved,
        );
        switch (next._tag) {
          case "Write": {
            const { state } = next.input;
            const authored = authoredTree(next.input);
            yield* checkTree(authored);
            // A real edit made during an unfinished write keeps its original ancestry, without
            // claiming the already downloaded files as new authored content.
            const edited = (yield* store.putTree(authored)) !== state.from;
            if (edited) {
              const recorded = yield* History.record(
                store,
                authored,
                state.base === null ? [] : [state.base],
                options.author,
              );
              yield* remote.post(recorded.id, recorded.revision, authored);
            }
            // Apply pending changes to the authored input, not our own partial application.
            // Otherwise removing one child during a directory replacement looks like a newer
            // structural edit and can defeat the pending file. Real edits still participate.
            const target = yield* loadRevision(
              store,
              state.next._tag === "Sending" ? state.next.revision : state.next.base,
            );
            const merged = Merge.runDecided(
              options.merger,
              {
                base: Option.some(next.input.from),
                ours: Option.some(authored),
                theirs: Option.some(next.input.to),
              },
              options.decide({
                ours: DateTime.makeUnsafe(options.author.at),
                theirs: yield* editedAt(remote, target),
              }),
            );
            const files = History.sortTree(Option.getOrElse(merged.value, () => []));
            yield* checkTree(files);
            const hash = yield* store.putTree(files);
            // The merged tree is not the one the interrupted Writing names: save a Writing for
            // exactly this write before it starts, so it is recoverable too (A12).
            const prepared = yield* options.prepareWrite(
              Writing.make({
                base: state.base,
                from: progress.local.hash,
                to: hash,
                next: state.next,
                merged: true,
              }),
            );
            yield* options.write(prepared, progress.local.tree, files);
            return yield* step(
              {
                ...progress,
                state: yield* saved(state.next),
                local: { hash, tree: files },
                choices: [...progress.choices, ...merged.choices],
                status: stronger(
                  progress,
                  edited || state.merged || state.next._tag === "Sending" ? "merged" : "pulled",
                ),
              },
              steps + 1,
            );
          }
          case "Blocked":
            return { state: progress.state, outcome: { status: "blocked", removal: next.removal } };
          case "UpToDate": {
            const state =
              progress.state._tag === "Idle" && progress.state.base === next.base
                ? progress.state
                : yield* saved(Idle.make({ base: next.base }));
            const before = new Map(start.tree.map((entry) => [entry.path, entry]));
            const after = new Map(progress.local.tree.map((entry) => [entry.path, entry]));
            const paths = [...new Set([...before.keys(), ...after.keys()])]
              .filter(
                (path) =>
                  !Option.makeEquivalence(Schema.toEquivalence(TreeEntry))(
                    Option.fromUndefinedOr(before.get(path)),
                    Option.fromUndefinedOr(after.get(path)),
                  ),
              )
              .sort();
            const revision = next.base;
            const outcome: Outcome =
              progress.status === "merged"
                ? { status: "merged", revision, paths, choices: progress.choices }
                : progress.status === "pulled"
                  ? { status: "pulled", revision, paths }
                  : { status: progress.status, revision };
            return { state, outcome };
          }
          case "Pull": {
            const prepared = yield* options.prepareWrite(
              Writing.make({
                base:
                  progress.state._tag === "Sending" ? progress.state.revision : progress.state.base,
                from: progress.local.hash,
                to: next.current.revision.tree,
                next: { _tag: "Idle", base: next.current.id },
                merged: false,
              }),
            );
            yield* options.write(prepared, progress.local.tree, next.current.tree);
            return yield* step(
              {
                ...progress,
                state: yield* saved(Idle.make({ base: next.current.id })),
                local: { hash: next.current.revision.tree, tree: next.current.tree },
                status: stronger(progress, "pulled"),
              },
              steps + 1,
            );
          }
          case "Push": {
            const ours = yield* send(next.ours, progress.local.tree);
            const sending = yield* saved(Sending.make({ base: next.expected, revision: ours.id }));
            const landed = yield* moved(next.expected, ours.id);
            return yield* step(
              landed
                ? {
                    ...progress,
                    state: yield* saved(Idle.make({ base: ours.id })),
                    status: stronger(progress, "pushed"),
                  }
                : { ...progress, state: sending },
              steps + 1,
            );
          }
          case "Merge": {
            // LocalRevision is posted first, so the side a merge does not keep stays on the Registry.
            const ours = yield* send(next.ours, progress.local.tree);
            const theirs = next.theirs;
            const merged = Merge.runDecided(
              options.merger,
              {
                base: Option.map(Option.fromNullishOr(next.base), (base) => base.tree),
                ours: Option.some(ours.tree),
                theirs: Option.some(theirs.tree),
              },
              options.decide({
                ours: yield* editedAt(remote, ours),
                theirs: yield* editedAt(remote, theirs),
              }),
            );
            const tree = History.sortTree(Option.getOrElse(merged.value, () => []));
            yield* checkTree(tree);
            const recorded = yield* History.record(store, tree, [theirs.id, ours.id], {
              device: options.author.device,
              at: yield* Clock.currentTimeMillis,
            });
            yield* remote.post(recorded.id, recorded.revision, tree);
            // Keep the file write recoverable before it can change anything. Once complete,
            // the merge is a send whose base is theirs until its move lands.
            const sending = Sending.make({ base: theirs.id, revision: recorded.id });
            const prepared = yield* options.prepareWrite(
              Writing.make({
                base: next.base?.id ?? null,
                from: progress.local.hash,
                to: recorded.revision.tree,
                next: sending,
                merged: true,
              }),
            );
            yield* options.write(prepared, progress.local.tree, tree);
            yield* saved(sending);
            const landed = yield* moved(theirs.id, recorded.id);
            return yield* step(
              {
                state: landed ? yield* saved(Idle.make({ base: recorded.id })) : sending,
                local: { hash: recorded.revision.tree, tree },
                status: "merged",
                choices: [...progress.choices, ...merged.choices],
              },
              steps + 1,
            );
          }
        }
      });

    return yield* step(
      { state: options.state, local: start, status: "up_to_date", choices: [] },
      0,
    );
  })();
