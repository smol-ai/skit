import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import * as History from "../src/history/history.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { type TreeEntry } from "../src/artifact/tree-entry.js";
import { memoryStore } from "./helpers/memory-store.js";

const device = makeMachineId();
const file = (path: string, text: string): TreeEntry => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: new TextEncoder().encode(text),
});

describe("identity", () => {
  it.effect("missing path times refuse a later observation instead of inventing a time", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const tree = [file("x", "original")];
      const bad = yield* store.commit({
        tree: yield* store.putTree(tree),
        parents: [],
        author: { device, at: 1 },
        edits: {},
      });
      expect(
        yield* Effect.flip(History.record(store, tree, [bad], { device, at: 2 })),
      ).toMatchObject({
        _tag: "History.StoreCorrupt",
        reason: { _tag: "EditTimesMismatch", paths: ["x"] },
      });
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("unrelated observations keep each path's original edit time", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const root = yield* History.record(store, [file("x", "0"), file("y", "0")], [], {
        device,
        at: 1,
      });
      const x = yield* History.record(store, [file("x", "1"), file("y", "0")], [root.id], {
        device,
        at: 2,
      });
      const y = yield* History.record(store, [file("x", "1"), file("y", "1")], [x.id], {
        device,
        at: 3,
      });
      expect(y.revision.edits).toEqual({ x: 2, y: 3 });
      const back = yield* History.record(store, [file("x", "0"), file("y", "1")], [y.id], {
        device,
        at: 4,
      });
      expect(back.revision.edits).toEqual({ x: 4, y: 3 });
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("merges and copied observations inherit their inputs' per-path times", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const root = yield* History.record(store, [file("x", "0"), file("y", "0")], [], {
        device,
        at: 1,
      });
      const ours = yield* History.record(store, [file("x", "1"), file("y", "0")], [root.id], {
        device,
        at: 2,
      });
      const theirs = yield* History.record(store, [file("x", "0"), file("y", "1")], [root.id], {
        device,
        at: 3,
      });
      const tree = [file("x", "1"), file("y", "1")];
      const merged = yield* History.record(store, tree, [ours.id, theirs.id], { device, at: 100 });
      expect(merged.revision.edits).toEqual({ x: 2, y: 3 });
      // The observer can scan downloaded bytes before sync completes its final scan.
      const observed = yield* History.record(store, tree, [ours.id], { device, at: 200 });
      expect(observed.revision.edits).toEqual({ x: 2, y: 200 });
      const copied = yield* History.record(
        store,
        tree,
        [observed.id],
        { device, at: 201 },
        { source: merged.id },
      );
      expect(copied.revision.edits).toEqual({ x: 2, y: 3 });
      const unchanged = yield* History.record(
        store,
        tree,
        [copied.id],
        { device, at: 202 },
        { source: merged.id },
      );
      expect(unchanged.id).toBe(copied.id);
      const normalized = yield* History.record(
        store,
        tree,
        [],
        { device, at: 500 },
        { source: copied.id },
      );
      expect(normalized.revision.edits).toEqual({ x: 2, y: 3 });
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("a tree's hash ignores entry order", () =>
    Effect.gen(function* () {
      const [a, b] = [file("a.md", "a"), file("b.md", "b")];
      expect(yield* History.treeHash([a, b])).toBe(yield* History.treeHash([b, a]));
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("a mode or symlink change is a different tree", () =>
    Effect.gen(function* () {
      const plain = file("run.sh", "echo");
      const executable: TreeEntry = {
        path: "run.sh",
        kind: "file",
        mode: 0o755,
        bytes: new TextEncoder().encode("echo"),
      };
      const link: TreeEntry = { path: "run.sh", kind: "symlink", target: "other.sh" };
      const hashes = new Set([
        yield* History.treeHash([plain]),
        yield* History.treeHash([executable]),
        yield* History.treeHash([link]),
      ]);
      expect(hashes.size).toBe(3);
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("recording the same revision twice yields one identity", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const author = { device, at: 1 };
      const first = yield* History.record(store, [file("a.md", "a")], [], author);
      const again = yield* History.record(store, [file("a.md", "a")], [], author);
      expect(again.id).toBe(first.id);
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("returning to earlier content is a new revision that shares its tree", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const a = yield* History.record(store, [file("a.md", "a")], [], { device, at: 1 });
      const b = yield* History.record(store, [file("a.md", "b")], [a.id], { device, at: 2 });
      const back = yield* History.record(store, [file("a.md", "a")], [b.id], { device, at: 3 });
      expect(back.id).not.toBe(a.id);
      expect(back.revision.tree).toBe(a.revision.tree);
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );
});

describe("store", () => {
  it.effect("refuses a revision whose tree it does not hold", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const tree = yield* History.treeHash([file("a.md", "a")]);
      const failure = yield* Effect.flip(
        store.commit({ tree, edits: { "a.md": 1 }, parents: [], author: { device, at: 1 } }),
      );
      expect(failure).toMatchObject({ _tag: "History.StoreMissing", kind: "tree", hash: tree });
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("holds a shallow history: a pulled revision without its parent", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const tree = yield* store.putTree([file("a.md", "a")]);
      const unknown = yield* History.revisionId({
        tree,
        edits: { "a.md": 9 },
        parents: [],
        author: { device, at: 9 },
      });
      const pulled = yield* store.commit({
        tree,
        edits: { "a.md": 10 },
        parents: [unknown],
        author: { device, at: 10 },
      });
      const failure = yield* Effect.flip(Stream.runCollect(History.ancestors(store, pulled)));
      expect(failure).toMatchObject({
        _tag: "History.StoreMissing",
        kind: "revision",
        hash: unknown,
      });
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );

  it.effect("ancestors visit a merge's parents once each, first parent first", () =>
    Effect.gen(function* () {
      const store = yield* memoryStore;
      const root = yield* History.record(store, [file("a.md", "0")], [], { device, at: 1 });
      const ours = yield* History.record(store, [file("a.md", "1")], [root.id], { device, at: 2 });
      const theirs = yield* History.record(store, [file("a.md", "2")], [root.id], {
        device,
        at: 3,
      });
      const merge = yield* History.record(store, [file("a.md", "3")], [ours.id, theirs.id], {
        device,
        at: 4,
      });
      const visited = yield* Stream.runCollect(History.ancestors(store, merge.id));
      expect(visited.map((entry) => entry.id)).toEqual([merge.id, ours.id, theirs.id, root.id]);
    }).pipe(Effect.provide(NodeCrypto.layerDigest)),
  );
});
