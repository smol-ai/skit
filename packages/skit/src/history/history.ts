/**
 * Content-addressed history: immutable trees, revisions that name their parents, and a store
 * that holds both. The device and the Registry share this model, so a revision recorded on a
 * device has the same identity everywhere it is copied.
 *
 * - A {@link Tree} is a workspace's files, directories and symlinks. Its hash is its identity.
 * - A {@link Revision} is a tree, its parents and who made it. An edit has one parent, a merge
 *   has two, and the first revision has none. Its identity is the hash of all three, so recording
 *   the same revision twice yields the same identity; because the author includes the time,
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

/** A physical namespace may have directory parents, never file or symlink parents. Raw
 * history remains unrestricted; sync and ingress call this before accepting a writable tree. */
export const treePathIssue = (
  tree: Tree,
): { readonly path: string; readonly message: string } | undefined => {
  const entries = new Map<string, TreeEntry["kind"]>();
  for (const entry of tree) {
    if (entries.has(entry.path)) return { path: entry.path, message: "Duplicate tree path" };
    entries.set(entry.path, entry.kind);
  }
  for (const entry of tree)
    for (const parent of parentDirectories(entry.path)) {
      const kind = entries.get(parent);
      if (kind !== undefined && kind !== "directory")
        return { path: entry.path, message: `A ${kind} at ${parent} cannot contain descendants` };
    }
  return undefined;
};

/** Which device made a revision, and when, in milliseconds since the epoch. */
export const Author = Schema.Struct({ device: MachineId, at: Schema.Int });
export type Author = typeof Author.Type;

export const Revision = Schema.Struct({
  tree: TreeHash,
  parents: Schema.Array(RevisionId),
  author: Author,
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
class StoreMissing extends Schema.TaggedError<StoreMissing>()("History.StoreMissing", {
  kind: Schema.Literals(["tree", "revision"]),
  hash: Hash,
}) {}

/** Stored bytes that no longer match the identity they are stored under. */
export class StoreCorrupt extends Schema.TaggedError<StoreCorrupt>()("History.StoreCorrupt", {
  kind: Schema.Literals(["tree", "revision"]),
  hash: Hash,
  reason: Schema.String,
}) {}

/** The store could not read or write, for example because its storage failed. */
export class StoreFailed extends Schema.TaggedError<StoreFailed>()("History.StoreFailed", {
  cause: Schema.Defect(),
}) {}

export const StoreError = Schema.Union([StoreMissing, StoreCorrupt, StoreFailed]);
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
        Effect.mapError((error) => new StoreCorrupt({ kind, hash, reason: String(error) })),
      );
      if ((yield* identity(value)) !== hash)
        return yield* new StoreCorrupt({ kind, hash, reason: "content hash does not match" });
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

/** Record `tree` in `store` as a new revision on top of `parents`. */
export const record = Effect.fn("History.record")(function* (
  store: Store,
  tree: Tree,
  parents: ReadonlyArray<RevisionId>,
  author: Author,
) {
  const hash = yield* store.putTree(tree);
  const revision: Revision = { tree: hash, parents, author };
  return { id: yield* store.commit(revision), revision };
});

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
