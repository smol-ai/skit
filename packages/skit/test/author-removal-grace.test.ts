import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeRemovalGrace } from "../src/author/removal-grace.js";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import { makeMachineId } from "../src/library/entity-ids.js";

const hash = History.TreeHash.make(`sha256:${"1".repeat(64)}`);
const id = History.RevisionId.make(`sha256:${"2".repeat(64)}`);
const tree: History.Tree = ["a", "b", "c"].map((path) => ({
  kind: "file",
  path,
  bytes: new Uint8Array([1]),
  mode: 0o644,
}));
const input = (kept: string[]): Sync.PlanInput => ({
  _tag: "Idle",
  local: { hash, tree: tree.filter((entry) => kept.includes(entry.path)) },
  base: {
    id,
    tree,
    revision: { tree: hash, parents: [], author: { device: makeMachineId(), at: 0 } },
  },
  current: null,
});

it.effect(
  "a removal requires two observations ten seconds apart; unreadability and restoration restart its grace",
  () =>
    Effect.gen(function* () {
      const grace = makeRemovalGrace();
      const removed = input(["a", "b"]);
      expect(yield* grace.check(removed)).toMatchObject({ paths: ["c"] });
      yield* TestClock.adjust("9 seconds");
      expect(yield* grace.check(removed)).toBeDefined();
      yield* grace.reset;
      yield* TestClock.adjust("2 seconds");
      expect(yield* grace.check(removed)).toBeDefined();
      yield* TestClock.adjust("10 seconds");
      expect(yield* grace.check(removed)).toBeUndefined();
      yield* grace.check(input(["a", "b", "c"]));
      expect(yield* grace.check(removed)).toBeDefined();
    }),
);

it.effect("bulk removal remains blocked after time passes and cannot carry an earlier grace", () =>
  Effect.gen(function* () {
    const grace = makeRemovalGrace();
    yield* grace.check(input(["a", "b"]));
    yield* TestClock.adjust("20 seconds");
    const empty = input([]);
    yield* grace.check(empty);
    expect(Sync.plan(empty)).toMatchObject({ _tag: "Blocked", removal: { deleting: 3 } });
    expect(yield* grace.check(input(["a", "b"]))).toBeDefined();
  }),
);
