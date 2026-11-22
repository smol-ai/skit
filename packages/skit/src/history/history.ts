import { SchemaFailure } from "../shared/schema-issue.js";
/**
 * Content-addressed history: immutable trees, revisions that name their parents, and a store
 * that holds both. The device and the Registry share this model, so a revision recorded on a
 * device has the same identity everywhere it is copied.
 *
 * - A {@link Tree} is a workspace's files, directories and symlinks. Its hash is its identity.
 * - A {@link Revision} is a tree, its parents and who made it. An edit has one parent, a merge
 *   has two, and the first revision has none. Its identity hashes the tree, parents, author and
 *   per-path edit times. Recording the same revision twice yields the same identity; because the author includes the time,
 *   returning to earlier content is still a new revision.
 *
 * A store may hold a shallow history: a device keeps the revisions it pulled without their
 * parents, which stay on the Registry. The Registry's store holds every parent.
 */
import { Array, Effect, Option, Order, Schema, Stream } from "effect";
import { Digest } from "effect/crypto";
import { TreeEntry } from "../artifact/tree-entry.js";
import { MachineId } from "../library/entity-ids.js";
import { sha256Hash, Hash } from "../shared/hash.js";
import { canonicalJson } from "../shared/json.js";
import { parentDirectories } from "../shared/relative-path.js";

export const TreeHash = Hash.pipe(Schema.brand("TreeHash"));
export type TreeHash = typeof TreeHash.Type;

export const RevisionId = Hash.pipe(Schema.brand("RevisionId"));
export type RevisionId = typeof RevisionId.Type;

/** Entries in path order. Paths are relative and use `/`. */
export const Tree = Schema.Array(TreeEntry);
export type Tree = typeof Tree.Type;

export const TreePathIssue = Schema.TaggedUnion({
  DuplicatePath: { path: Schema.String },
  ParentNotDirectory: {
    path: Schema.String,
    parent: Schema.String,
    kind: Schema.Literals(["file", "symlink"]),
  },
});
export type TreePathIssue = typeof TreePathIssue.Type;

/** A physical namespace may have directory parents, never file or symlink parents. Raw
 * history remains unrestricted; sync and ingress call this before accepting a writable tree. */
export const treePathIssue = (tree: Tree): TreePathIssue | undefined => {
  const entries = new Map<string, TreeEntry["kind"]>();
  for (const entry of tree) {
    if (entries.has(entry.path)) return { _tag: "DuplicatePath", path: entry.path };
    entries.set(entry.path, entry.kind);
  }
  for (const entry of tree)
    for (const parent of parentDirectories(entry.path)) {
      const kind = entries.get(parent);
      if (kind !== undefined && kind !== "directory")
        return { _tag: "ParentNotDirectory", path: entry.path, parent, kind };
    }
  return undefined;
};

/** Which device made a revision, and when, in milliseconds since the epoch. */
export const Author = Schema.Struct({ device: MachineId, at: Schema.Int });
export type Author = typeof Author.Type;

/** Observed edit time in milliseconds at each NFC path, independent of changes elsewhere. */
export const EditTimes = Schema.Record(Schema.String, Schema.Int);
export type EditTimes = typeof EditTimes.Type;

/** Missing or unrelated clock keys cannot participate in a path-based decision. */
export const editTimePaths = (tree: Tree, edits: EditTimes): ReadonlyArray<string> => {
  const paths = new Set(tree.map((entry) => entry.path.normalize("NFC")));
  return [
    ...new Set([
      ...[...paths].filter((path) => !Object.hasOwn(edits, path)),
      ...Object.keys(edits).filter((path) => !paths.has(path)),
    ]),
  ].sort();
};

export const Revision = Schema.Struct({
  tree: TreeHash,
  parents: Schema.Array(RevisionId),
  author: Author,
  edits: EditTimes,
});
export type Revision = typeof Revision.Type;

/** The hash of a value's canonical JSON. A typed value always encodes, so failing to is a defect. */
const hashValue = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
  Schema.encodeEffect(Schema.toCodecJson(schema))(value).pipe(
    Effect.orDie,
    Effect.flatMap((json) => sha256Hash(new TextEncoder().encode(canonicalJson(json)))),
  );

/** The tree with its entries in path order, as it is hashed and stored. */
export const sortTree = (tree: Tree): Tree =>
  Array.sort(
    tree,
    Order.mapInput(Order.String, (entry: TreeEntry) => entry.path),
  );

export const treeHash = (tree: Tree) =>
  hashValue(Tree, sortTree(tree)).pipe(Effect.map((hash) => TreeHash.make(hash)));

export const revisionId = (revision: Revision) =>
  hashValue(Revision, revision).pipe(Effect.map((hash) => RevisionId.make(hash)));

/** What a store holds: trees and the revisions that name them. */
export type Kind = "tree" | "revision";

/** Something the store was asked for and does not hold. */
class StoreMissing extends Schema.TaggedError<StoreMissing, { readonly brand: unique symbol }>()(
  "History.StoreMissing",
  {
    kind: Schema.Literals(["tree", "revision"]),
    hash: Hash,
  },
) {}

export const StoreCorruptReason = Schema.TaggedUnion({
  InvalidData: { failure: SchemaFailure },
  ContentHashMismatch: { actual: Hash },
  BlobMissing: { blob: Hash },
  BlobHashMismatch: { blob: Hash, actual: Hash },
  BlobNotFile: { blob: Hash },
  BlobSizeMismatch: { blob: Hash, expected: Schema.Int, actual: Schema.Int },
  EditTimesMismatch: { paths: Schema.Array(Schema.String) },
});
export type StoreCorruptReason = typeof StoreCorruptReason.Type;

/** Stored bytes that no longer match the identity they are stored under. */
export class StoreCorrupt extends Schema.TaggedError<
  StoreCorrupt,
  { readonly brand: unique symbol }
>()("History.StoreCorrupt", {
  kind: Schema.Literals(["tree", "revision"]),
  hash: Hash,
  reason: StoreCorruptReason,
}) {}

/** The store could not read or write, for example because its storage failed. */
export class StoreFailed extends Schema.TaggedError<
  StoreFailed,
  { readonly brand: unique symbol }
>()("History.StoreFailed", {
  cause: Schema.Defect(),
}) {}

export class RecordInvalid extends Schema.TaggedError<
  RecordInvalid,
  { readonly brand: unique symbol }
>()("History.RecordInvalid", { paths: Schema.Array(Schema.String) }) {}

export const StoreError = Schema.Union([StoreMissing, StoreCorrupt, StoreFailed, RecordInvalid]);
export type StoreError = typeof StoreError.Type;

/**
 * Where trees and revisions live. Writes are idempotent: putting what is already stored returns
 * the same identity and changes nothing. Reads verify what they return.
 *
 * `commit` requires the revision's tree but not its parents, so a store can hold a shallow
 * history. Whoever needs every parent present, like the Registry, checks them itself.
 *
 * A plain value, passed to whatever reads or writes history: each store has one owner, which
 * builds it over its own storage.
 */
export interface Store {
  readonly putTree: (tree: Tree) => Effect.Effect<TreeHash, StoreError>;
  readonly tree: (hash: TreeHash) => Effect.Effect<Tree, StoreError>;
  /** Whether a tree is stored, without reading or verifying it. */
  readonly hasTree: (hash: TreeHash) => Effect.Effect<boolean, StoreError>;
  /** Every stored tree's hash, in hash order. Reading one verifies it. */
  readonly trees: Effect.Effect<ReadonlyArray<TreeHash>, StoreError>;
  readonly commit: (revision: Revision) => Effect.Effect<RevisionId, StoreError>;
  readonly revision: (id: RevisionId) => Effect.Effect<Revision, StoreError>;
}

/**
 * The storage under a {@link Store}: one text document per kind and hash. It knows nothing of
 * what documents mean; {@link makeStore} encodes, hashes and verifies them.
 */
export interface Backend {
  /** The document stored under `hash`, or none. */
  readonly read: (
    kind: Kind,
    hash: Hash,
  ) => Effect.Effect<Option.Option<string>, StoreFailed | StoreCorrupt>;
  /** Store `text` under `hash` durably, leaving a document already stored there as it is. */
  readonly write: (
    kind: Kind,
    hash: Hash,
    text: string,
  ) => Effect.Effect<void, StoreFailed | StoreCorrupt>;
  readonly has: (kind: Kind, hash: Hash) => Effect.Effect<boolean, StoreFailed>;
  /** Every hash stored under `kind`, in hash order. */
  readonly list: (kind: Kind) => Effect.Effect<ReadonlyArray<Hash>, StoreFailed>;
}

const TreeDocument = Schema.fromJsonString(Schema.toCodecJson(Tree));
const RevisionDocument = Schema.fromJsonString(Schema.toCodecJson(Revision));

/**
 * A {@link Store} over `backend`. Every write is read back and verified, including a document an
 * earlier write left, so a corrupt document is never treated as a saved copy; every read checks
 * the document's hash against the identity it is stored under.
 */
export const makeStore = Effect.fn("History.makeStore")(function* (
  backend: Backend,
): Effect.fn.Return<Store, never, Digest.Digest> {
  const digests = yield* Digest.Digest;
  const read = <A, H extends Hash>(
    kind: Kind,
    hash: H,
    document: Schema.Codec<A, string>,
    identity: (value: A) => Effect.Effect<H, never, Digest.Digest>,
  ) =>
    Effect.gen(function* () {
      const text = yield* backend.read(kind, hash);
      if (Option.isNone(text)) return yield* new StoreMissing({ kind, hash });
      const value = yield* Schema.decodeEffect(document)(text.value).pipe(
        Effect.mapError(
          (error) =>
            new StoreCorrupt({ kind, hash, reason: { _tag: "InvalidData", failure: error } }),
        ),
      );
      const actual = yield* identity(value);
      if (actual !== hash)
        return yield* new StoreCorrupt({
          kind,
          hash,
          reason: { _tag: "ContentHashMismatch", actual },
        });
      return value;
    }).pipe(Effect.provideService(Digest.Digest, digests));
  const put = <A, H extends Hash>(
    kind: Kind,
    value: A,
    document: Schema.Codec<A, string>,
    identity: (value: A) => Effect.Effect<H, never, Digest.Digest>,
  ) =>
    Effect.gen(function* () {
      const hash = yield* identity(value);
      // A typed value always encodes, so failing to is a defect.
      yield* backend.write(kind, hash, yield* Effect.orDie(Schema.encodeEffect(document)(value)));
      yield* read(kind, hash, document, identity);
      return hash;
    }).pipe(Effect.provideService(Digest.Digest, digests));
  return {
    putTree: (tree) => put("tree", sortTree(tree), TreeDocument, treeHash),
    tree: (hash) => read("tree", hash, TreeDocument, treeHash),
    hasTree: (hash) => backend.has("tree", hash),
    trees: backend.list("tree").pipe(Effect.map(Array.map((hash) => TreeHash.make(hash)))),
    commit: (revision) =>
      Effect.gen(function* () {
        if (!(yield* backend.has("tree", revision.tree)))
          return yield* new StoreMissing({ kind: "tree", hash: revision.tree });
        return yield* put("revision", revision, RevisionDocument, revisionId);
      }),
    revision: (id) => read("revision", id, RevisionDocument, revisionId),
  };
});

/** Per-path times for a newly authored tree or a merge of existing trees. */
export const editTimes = (
  tree: Tree,
  previous: ReadonlyArray<{ readonly tree: Tree; readonly edits: EditTimes }>,
  at: number,
): EditTimes => {
  const same = Schema.toEquivalence(TreeEntry);
  const find = (tree: Tree, path: string) =>
    tree.find((entry) => entry.path.normalize("NFC") === path);
  const matches = (entry: TreeEntry, tree: Tree) => {
    const found = find(tree, entry.path.normalize("NFC"));
    return found !== undefined && same({ ...entry, path: found.path }, found);
  };
  const timesByPath = new Map<string, number>();
  for (const entry of tree) {
    const path = entry.path.normalize("NFC");
    const unchanged = previous.filter((parent) => matches(entry, parent.tree));
    const times = unchanged.flatMap((parent) =>
      Object.hasOwn(parent.edits, path) ? [parent.edits[path]!] : [],
    );
    // A synthesized merge is as recent as its contributing edits, never the merge clock.
    if (times.length === 0 && previous.length > 1)
      for (const parent of previous) {
        const time = editTime(parent.edits, path);
        if (time !== undefined) times.push(time);
      }
    timesByPath.set(path, times.length === 0 ? at : Math.max(...times));
  }
  return Object.fromEntries(timesByPath);
};

/** Record `tree` in `store` as a new revision on top of `parents`. */
export const record = Effect.fn("History.record")(function* (
  store: Store,
  tree: Tree,
  parents: ReadonlyArray<RevisionId>,
  author: Author,
  options: { readonly source?: RevisionId; readonly edits?: EditTimes } = {},
) {
  const load = (id: RevisionId) =>
    Effect.gen(function* () {
      const revision = yield* store.revision(id);
      const tree = yield* store.tree(revision.tree);
      const paths = editTimePaths(tree, revision.edits);
      if (paths.length)
        return yield* new StoreCorrupt({
          kind: "revision",
          hash: id,
          reason: { _tag: "EditTimesMismatch", paths },
        });
      return { revision, tree };
    });
  const previous = yield* Effect.forEach(parents, load);
  const copied = options.source === undefined ? undefined : yield* load(options.source);
  const edits = {
    ...(options.edits ??
      editTimes(
        tree,
        previous.map(({ tree, revision }) => ({ tree, edits: revision.edits })),
        author.at,
      )),
  };
  if (copied !== undefined) {
    const same = Schema.toEquivalence(TreeEntry);
    for (const entry of tree) {
      const path = entry.path.normalize("NFC");
      const original = copied.tree.find((file) => file.path.normalize("NFC") === path);
      if (original !== undefined && same({ ...entry, path: original.path }, original))
        edits[path] = copied.revision.edits[path]!;
    }
  }
  const paths = editTimePaths(tree, edits);
  if (paths.length > 0) return yield* new RecordInvalid({ paths });
  const hash = yield* store.putTree(tree);
  // A post-sync scan can already have been saved by the background observer. Correct
  // copied-path provenance when needed, but do not add another identical observation.
  if (
    options.source !== undefined &&
    parents.length === 1 &&
    previous[0]!.revision.tree === hash &&
    Schema.toEquivalence(EditTimes)(previous[0]!.revision.edits, edits)
  )
    return { id: parents[0]!, revision: previous[0]!.revision };
  const revision: Revision = { tree: hash, parents, author, edits };
  return { id: yield* store.commit(revision), revision };
});

/** A structural overlap uses the latest edit within the whole conflicting subtree. */
export const editTime = (edits: EditTimes, path: string): number | undefined => {
  const times = Object.entries(edits)
    .filter(([candidate]) => path === "" || candidate === path || candidate.startsWith(`${path}/`))
    .map(([, time]) => time);
  return times.length === 0 ? undefined : Math.max(...times);
};

/**
 * Every revision reachable from `id`, starting there, each once. Parents are visited breadth
 * first and in order, so a revision's first parent comes before its second. In a shallow store
 * the stream fails with {@link StoreMissing} where the stored history ends.
 */
export const ancestors = (
  store: Store,
  id: RevisionId,
): Stream.Stream<{ readonly id: RevisionId; readonly revision: Revision }, StoreError> => {
  const start: {
    readonly queue: ReadonlyArray<RevisionId>;
    readonly seen: ReadonlySet<RevisionId>;
  } = { queue: [id], seen: new Set() };
  return Stream.unfold(start, ({ queue, seen }) =>
    Effect.gen(function* () {
      const [next, ...rest] = queue.filter((candidate) => !seen.has(candidate));
      if (next === undefined) return undefined;
      const revision = yield* store.revision(next);
      return [
        { id: next, revision },
        { queue: [...rest, ...revision.parents], seen: new Set(seen).add(next) },
      ] as const;
    }),
  );
};

// Required to name inferred history failures in generated declarations.
export type { StoreMissing };
