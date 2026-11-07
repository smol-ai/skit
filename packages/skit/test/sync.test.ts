import { NodeCrypto } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Data, DateTime, Effect, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe as group, expect as check, test } from "vitest";
import * as History from "../src/history/history.js";
import * as Sync from "../src/sync/sync.js";
import type * as Merge from "../src/sync/merge.js";
import { FailureTypeId, type SkitFailure } from "../src/shared/failure.js";
import { mergeAuthorTree } from "../src/author/merge/files.js";
import { makeMachineId } from "../src/library/entity-ids.js";
import { type TreeEntry } from "../src/artifact/tree-entry.js";
import { memoryStore } from "./helpers/memory-store.js";

const file = (path: string, text: string): TreeEntry => ({
  path,
  kind: "file",
  mode: 0o644,
  bytes: new TextEncoder().encode(text),
});

describe("plan", () => {
  // Plan compares identities and paths only, so these stand in for real hashes.
  const hex = (name: string) => Buffer.from(name).toString("hex");
  const treeHash = (name: string) => History.TreeHash.make(`sha256:${hex(name).padStart(64, "0")}`);
  const revisionId = (name: string) =>
    History.RevisionId.make(`sha256:${hex(name).padStart(64, "f")}`);
  const author = { device: makeMachineId(), at: 1 };
  const files = (...paths: ReadonlyArray<string>) => paths.map((path) => file(path, path));
  const held = (
    name: string,
    tree: History.Tree,
    parents: ReadonlyArray<string> = [],
  ): Sync.LoadedRevision => ({
    id: revisionId(name),
    revision: { tree: treeHash(name), parents: parents.map(revisionId), author },
    tree,
  });
  const local = (name: string, tree: History.Tree = []) => ({ hash: treeHash(name), tree });
  const idle = (
    localTree: ReturnType<typeof local>,
    base: Sync.LoadedRevision | null,
    current: Sync.LoadedRevision | null,
  ): Sync.PlanInput => ({ _tag: "Idle", local: localTree, base, current });
  const localOurs = (...parents: ReadonlyArray<string>) => ({
    _tag: "Local" as const,
    parents: parents.map(revisionId),
  });

  group("idle", () => {
    test("with no current, the device pushes the first revision", () => {
      check(Sync.plan(idle(local("a"), null, null))).toEqual({
        _tag: "Push",
        ours: localOurs(),
        expected: null,
      });
    });

    test("a current matching the local tree is up to date, whatever the base", () => {
      for (const base of [null, held("b", [])])
        check(Sync.plan(idle(local("c"), base, held("c", [])))).toEqual({
          _tag: "UpToDate",
          base: revisionId("c"),
        });
    });

    test("an empty device that never synced pulls", () => {
      const current = held("c", []);
      check(Sync.plan(idle(local("e"), null, current))).toEqual({ _tag: "Pull", current });
    });

    test("a device that never synced merges with no base, so it deletes nothing", () => {
      const current = held("c", []);
      check(Sync.plan(idle(local("l", files("mine")), null, current))).toEqual({
        _tag: "Merge",
        base: null,
        ours: localOurs(),
        theirs: current,
      });
    });

    test("only the device changed: push on top of the base", () => {
      check(Sync.plan(idle(local("l"), held("b", []), held("b", [])))).toEqual({
        _tag: "Push",
        ours: localOurs("b"),
        expected: revisionId("b"),
      });
    });

    test("only the Registry changed: pull", () => {
      const current = held("c", [], ["b"]);
      check(Sync.plan(idle(local("b"), held("b", []), current))).toEqual({
        _tag: "Pull",
        current,
      });
    });

    test("both changed: merge ours with theirs from the base", () => {
      const [base, current] = [held("b", []), held("c", [], ["b"])];
      check(Sync.plan(idle(local("l"), base, current))).toEqual({
        _tag: "Merge",
        base,
        ours: localOurs("b"),
        theirs: current,
      });
    });
  });

  group("removal safety", () => {
    const base = held("b", files("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"));
    const view = (tree: History.Tree, current = base) => idle(local("l", tree), base, current);

    test("deleting more than five files and more than half blocks a push", () => {
      check(Sync.plan(view(files("1", "2", "3", "4")))).toEqual({
        _tag: "Blocked",
        removal: { deleting: 6, of: 10, paths: ["10", "5", "6", "7", "8", "9"] },
      });
    });

    test("deleting every file blocks, even one of one", () => {
      const single = held("b", files("only"));
      check(Sync.plan(idle(local("l"), single, single))).toEqual({
        _tag: "Blocked",
        removal: { deleting: 1, of: 1, paths: ["only"] },
      });
    });

    test("deleting five, or half, does not block", () => {
      check(Sync.plan(view(files("1", "2", "3", "4", "5")))._tag).toBe("Push");
    });

    test("a merge that deletes too many blocks too", () => {
      check(Sync.plan(view(files("1"), held("c", files("1", "2"), ["b"])))._tag).toBe("Blocked");
    });

    test("approval of the exact removal lets it through; any other removal still blocks", () => {
      const removal = { deleting: 6, of: 10, paths: ["10", "5", "6", "7", "8", "9"] };
      check(Sync.plan(view(files("1", "2", "3", "4")), removal)._tag).toBe("Push");
      check(Sync.plan(view(files("1", "2", "3")), removal)).toMatchObject({
        _tag: "Blocked",
        removal: { deleting: 7 },
      });
    });

    test("the Registry deleting files is a pull, never blocked", () => {
      const current = held("c", [], ["b"]);
      check(Sync.plan(idle(local("b"), base, current))).toEqual({ _tag: "Pull", current });
    });
  });

  group("sending", () => {
    const base = held("b", files("1"));
    const sent = held("s", files("1", "2"), ["b"]);
    const view = (
      localTree: string,
      current: Sync.LoadedRevision | null,
      from = base,
    ): Extract<Sync.PlanInput, { readonly _tag: "Sending" }> => ({
      _tag: "Sending",
      local: local(localTree, files("1", "2")),
      base: from,
      sent,
      current,
    });

    test("the move landed: plan from the sent revision", () => {
      check(Sync.plan(view("s", sent))).toEqual({ _tag: "UpToDate", base: revisionId("s") });
      check(Sync.plan(view("l", sent))).toEqual({
        _tag: "Push",
        ours: localOurs("s"),
        expected: revisionId("s"),
      });
    });

    test("the move never landed: move again, even if the device has edited since", () => {
      for (const localTree of ["s", "l"])
        check(Sync.plan(view(localTree, base))).toEqual({
          _tag: "Push",
          ours: { _tag: "Sent", sent },
          expected: revisionId("b"),
        });
      check(Sync.plan({ ...view("s", null), base: null })).toEqual({
        _tag: "Push",
        ours: { _tag: "Sent", sent },
        expected: null,
      });
    });

    test("another device moved first: merge the sent revision with theirs", () => {
      const theirs = held("c", files("1", "3"), ["b"]);
      check(Sync.plan(view("s", theirs))).toEqual({
        _tag: "Merge",
        base,
        ours: { _tag: "Sent", sent },
        theirs,
      });
    });

    test("edits made after sending are merged on top of the sent revision", () => {
      const theirs = held("c", files("1", "3"), ["b"]);
      check(Sync.plan(view("l", theirs))).toEqual({
        _tag: "Merge",
        base,
        ours: localOurs("s"),
        theirs,
      });
    });

    test("removal safety was decided when the revision was first sent", () => {
      const deleted = held("s", [], ["b"]);
      check(
        Sync.plan({ _tag: "Sending", local: local("s"), base, sent: deleted, current: base }),
      ).toEqual({ _tag: "Push", ours: { _tag: "Sent", sent: deleted }, expected: revisionId("b") });
    });
  });
});

class RemoteDown
  extends Data.TaggedError("RemoteDown")<{ readonly step: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Retry.";
}

/**
 * A Registry in memory. `before.move` runs before a move is compared, so a test can let another
 * device move first; `after.move` runs after a move landed, so a test can lose its response.
 */
const makeRegistry = () => {
  const revisions = new Map<
    History.RevisionId,
    { readonly revision: History.Revision; readonly tree: History.Tree }
  >();
  const registry: {
    readonly revisions: typeof revisions;
    current: History.RevisionId | null;
    posts: number;
    readonly before: { move: () => Effect.Effect<void, SkitFailure> };
    readonly after: {
      move: () => Effect.Effect<void, SkitFailure>;
      post: () => Effect.Effect<void, SkitFailure>;
    };
  } = {
    revisions,
    current: null,
    posts: 0,
    before: { move: (): Effect.Effect<void, SkitFailure> => Effect.void },
    after: {
      move: (): Effect.Effect<void, SkitFailure> => Effect.void,
      post: (): Effect.Effect<void, SkitFailure> => Effect.void,
    },
  };
  const remote: Sync.Remote = {
    current: Effect.sync(() => registry.current),
    revision: (id) => {
      const found = revisions.get(id);
      return found === undefined ? Effect.die(`no revision ${id}`) : Effect.succeed(found);
    },
    ancestors: (id) =>
      Stream.unfold<
        ReadonlyArray<History.RevisionId>,
        { readonly id: History.RevisionId; readonly revision: History.Revision },
        never,
        never
      >([id], (queue) => {
        const [next, ...rest] = queue;
        if (next === undefined) return Effect.undefined;
        const { revision } = revisions.get(next)!;
        return Effect.succeed([{ id: next, revision }, [...rest, ...revision.parents]] as const);
      }),
    post: (id, revision, tree) =>
      Effect.gen(function* () {
        for (const parent of revision.parents)
          if (!revisions.has(parent)) return yield* Effect.die(`missing parent ${parent}`);
        if (!revisions.has(id)) {
          registry.posts++;
          revisions.set(id, { revision, tree });
        }
        yield* registry.after.post();
      }),
    move: (expected, id) =>
      Effect.gen(function* () {
        yield* registry.before.move();
        if (!revisions.has(id)) return yield* Effect.die(`unknown revision ${id}`);
        if (registry.current !== expected)
          return yield* new Sync.Moved({ current: registry.current });
        registry.current = id;
        yield* registry.after.move();
      }),
  };
  return { registry, remote };
};
type Registry = ReturnType<typeof makeRegistry>;

/** One device: its own store, its files, and the states it saved. */
const makeDevice = Effect.fn("Test.makeDevice")(function* (
  { remote }: Registry,
  initial: History.Tree,
) {
  const store = yield* memoryStore;
  const device = makeMachineId();
  const saved: Array<Sync.SyncState> = [];
  const held: { files: History.Tree; state: Sync.SyncState } = {
    files: initial,
    state: Sync.Idle.make({ base: null }),
  };
  const self = Object.assign(held, {
    saved,
    store,
    sync: (options: { at: number; approved?: Sync.Removal; merger?: Merge.Merger<History.Tree> }) =>
      Effect.gen(function* () {
        const local = yield* store.putTree(self.files);
        const result = yield* Sync.run({
          store,
          remote,
          state: self.state,
          local,
          author: { device, at: options.at },
          merger: options.merger ?? mergeAuthorTree,
          // The later edit wins; this device breaks a tie.
          decide: (editedAt) => () =>
            DateTime.isGreaterThan(editedAt.theirs, editedAt.ours) ? "theirs" : "ours",
          ...(options.approved === undefined ? {} : { approved: options.approved }),
          save: (state) =>
            Effect.sync(() => {
              self.state = state;
              saved.push(state);
            }),
          prepareWrite: (state) =>
            Effect.sync(() => {
              self.state = state;
              saved.push(state);
            }),
          write: (_prepared, from, to) =>
            Effect.sync(() => {
              expect(from).toEqual(History.sortTree(self.files));
              self.files = to;
            }),
        });
        expect(result.state).toEqual(self.state);
        return result.outcome;
      }),
  });
  return self;
});

const text = (tree: History.Tree) =>
  Object.fromEntries(
    tree.map((entry) => [
      entry.path,
      entry.kind === "file" ? new TextDecoder().decode(entry.bytes) : entry.kind,
    ]),
  );

describe("run", () => {
  it.effect("a first push records the device's tree and points current at it", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("SKILL.md", "v1")]);
      const outcome = yield* a.sync({ at: 1 });
      expect(outcome).toMatchObject({ status: "pushed" });
      expect(registry.registry.current).toBe(outcome.status === "pushed" && outcome.revision);
      expect(a.state).toEqual(Sync.Idle.make({ base: registry.registry.current }));
      // The state named the send before the move.
      expect(a.saved.map((state) => state._tag)).toEqual(["Sending", "Idle"]);
    }),
  );

  it.effect("another device pulls, and a second sync is up to date", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("SKILL.md", "v1")]);
      const b = yield* makeDevice(registry, []);
      yield* a.sync({ at: 1 });
      expect(yield* b.sync({ at: 1 })).toMatchObject({ status: "pulled" }); // an empty device pulls
      expect(text(b.files)).toEqual({ "SKILL.md": "v1" });
      a.files = [file("SKILL.md", "v2")];
      yield* a.sync({ at: 2 });
      expect(yield* b.sync({ at: 1 })).toMatchObject({ status: "pulled" });
      expect(text(b.files)).toEqual({ "SKILL.md": "v2" });
      expect(yield* b.sync({ at: 1 })).toMatchObject({ status: "up_to_date" });
    }),
  );

  it.effect.each(["before-write", "after-write"] as const)(
    "a failed state save %s leaves a pull recoverable",
    (boundary) =>
      Effect.gen(function* () {
        const registry = makeRegistry();
        const a = yield* makeDevice(registry, [file("a.md", "first")]);
        const b = yield* makeDevice(registry, []);
        yield* a.sync({ at: 1 });
        const failed = yield* Sync.run({
          store: b.store,
          remote: registry.remote,
          state: b.state,
          local: yield* b.store.putTree(b.files),
          author: { device: makeMachineId(), at: 1 },
          merger: mergeAuthorTree,
          decide: () => () => "ours",
          save: (state) =>
            boundary === "after-write" && state._tag === "Idle"
              ? Effect.fail(new RemoteDown({ step: "save" }))
              : Effect.sync(() => {
                  b.state = state;
                }),
          prepareWrite: (state) =>
            boundary === "before-write"
              ? Effect.fail(new RemoteDown({ step: "save" }))
              : Effect.sync(() => {
                  b.state = state;
                }),
          write: (_prepared, _from, to) =>
            Effect.sync(() => {
              b.files = to;
            }),
        }).pipe(Effect.flip);
        expect(failed).toMatchObject({ _tag: "RemoteDown", step: "save" });
        expect(b.state._tag).toBe(boundary === "before-write" ? "Idle" : "Writing");
        expect(text(b.files)).toEqual(boundary === "before-write" ? {} : { "a.md": "first" });
        a.files = [file("a.md", "newer")];
        yield* a.sync({ at: 2 });
        expect(yield* b.sync({ at: 3 })).toMatchObject({ status: "pulled" });
        expect(text(b.files)).toEqual({ "a.md": "newer" });
      }),
  );

  it.effect("a lost race re-plans as a merge, and the losing side stays on the Registry", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "0"), file("b.md", "0")]);
      yield* a.sync({ at: 1 });
      const b = yield* makeDevice(registry, []);
      yield* b.sync({ at: 1 });
      a.files = [file("a.md", "a"), file("b.md", "0")];
      b.files = [file("a.md", "0"), file("b.md", "b")];
      // A moves first, while B's move is in flight.
      registry.registry.before.move = () => {
        registry.registry.before.move = () => Effect.void;
        return a.sync({ at: 2 }).pipe(Effect.orDie, Effect.asVoid);
      };
      const outcome = yield* b.sync({ at: 3 });
      expect(outcome).toMatchObject({ status: "merged", choices: [] });
      expect(text(b.files)).toEqual({ "a.md": "a", "b.md": "b" });
      const current = registry.registry.revisions.get(registry.registry.current!)!;
      expect(current.revision.parents).toHaveLength(2);
      const [theirs, ours] = current.revision.parents;
      expect(text(registry.registry.revisions.get(ours!)!.tree)).toEqual({
        "a.md": "0",
        "b.md": "b",
      });
      expect(theirs).toBe(a.state.base);
      expect(b.state).toEqual(Sync.Idle.make({ base: registry.registry.current }));
      // A pulls the merge.
      expect(yield* a.sync({ at: 2 })).toMatchObject({ status: "pulled" });
      expect(text(a.files)).toEqual({ "a.md": "a", "b.md": "b" });
    }),
  );

  it.effect("a merge reports each decided conflict, using when each side last edited", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "0")]);
      yield* a.sync({ at: 1 });
      const b = yield* makeDevice(registry, []);
      yield* b.sync({ at: 1 });
      a.files = [file("a.md", "from a")];
      yield* a.sync({ at: 5 });
      b.files = [file("a.md", "from b")];
      const outcome = yield* b.sync({ at: 3 });
      expect(outcome.status).toBe("merged");
      if (outcome.status === "merged")
        expect(outcome.choices.map(({ conflict, kept }) => [conflict.at[0], kept])).toEqual([
          ["a.md", "theirs"],
        ]);
      expect(text(b.files)).toEqual({ "a.md": "from a" });
      // B's version is not current, but it is on the Registry.
      const kept = [...registry.registry.revisions.values()].map((entry) => text(entry.tree));
      expect(kept).toContainEqual({ "a.md": "from b" });
    }),
  );

  it.effect("a merge's edit time is its latest parent's, read from the Registry's history", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "0"), file("b.md", "0")]);
      yield* a.sync({ at: 1 });
      const b = yield* makeDevice(registry, []);
      yield* b.sync({ at: 1 });
      const c = yield* makeDevice(registry, []);
      yield* c.sync({ at: 1 });
      // A and B merge at a late wall-clock time, but their content was edited at 2 and 3.
      a.files = [file("a.md", "a"), file("b.md", "0")];
      yield* a.sync({ at: 2 });
      b.files = [file("a.md", "0"), file("b.md", "b")];
      yield* TestClock.setTime(1_000);
      expect(yield* b.sync({ at: 3 })).toMatchObject({ status: "merged" });
      // C edited the same line at 4: later than both inputs of the merge, so C's version wins.
      c.files = [file("a.md", "c"), file("b.md", "0")];
      const outcome = yield* c.sync({ at: 4 });
      expect(outcome.status).toBe("merged");
      if (outcome.status === "merged")
        expect(outcome.choices.map(({ conflict, kept }) => [conflict.at[0], kept])).toEqual([
          ["a.md", "ours"],
        ]);
    }),
  );

  describe("an unknown outcome is recovered from Sending", () => {
    const lostMove = (registry: Registry) =>
      Effect.sync(() => {
        registry.registry.after.move = () => {
          registry.registry.after.move = () => Effect.void;
          return Effect.fail(new RemoteDown({ step: "move" }));
        };
      });

    it.effect("the move landed: the device is up to date with what it sent", () =>
      Effect.gen(function* () {
        const registry = makeRegistry();
        const a = yield* makeDevice(registry, [file("a.md", "1")]);
        yield* lostMove(registry);
        expect(yield* Effect.flip(a.sync({ at: 1 }))).toMatchObject({ _tag: "RemoteDown" });
        expect(a.state._tag).toBe("Sending");
        const posts = registry.registry.posts;
        expect(yield* a.sync({ at: 1 })).toMatchObject({ status: "up_to_date" });
        expect(registry.registry.posts).toBe(posts); // posting again changed nothing
        expect(a.state).toEqual(Sync.Idle.make({ base: registry.registry.current }));
      }),
    );

    it.effect("the move never landed: the device moves again", () =>
      Effect.gen(function* () {
        const registry = makeRegistry();
        const a = yield* makeDevice(registry, [file("a.md", "1")]);
        yield* a.sync({ at: 1 });
        const first = registry.registry.current;
        a.files = [file("a.md", "2")];
        registry.registry.before.move = () => {
          registry.registry.before.move = () => Effect.void;
          return Effect.fail(new RemoteDown({ step: "move" }));
        };
        yield* Effect.flip(a.sync({ at: 2 }));
        expect(a.state).toMatchObject({ _tag: "Sending", base: first });
        expect(registry.registry.current).toBe(first);
        expect(yield* a.sync({ at: 2 })).toMatchObject({ status: "pushed" });
        expect(registry.registry.current).toBe(a.state._tag === "Sending" ? null : a.state.base);
        expect(text(registry.registry.revisions.get(registry.registry.current!)!.tree)).toEqual({
          "a.md": "2",
        });
      }),
    );

    it.effect("the move landed and another device built on it: the device pulls", () =>
      Effect.gen(function* () {
        const registry = makeRegistry();
        const a = yield* makeDevice(registry, [file("a.md", "0")]);
        yield* a.sync({ at: 1 });
        a.files = [file("a.md", "x")];
        yield* lostMove(registry);
        yield* Effect.flip(a.sync({ at: 2 }));
        expect(a.state._tag).toBe("Sending");
        const b = yield* makeDevice(registry, []);
        yield* b.sync({ at: 3 });
        b.files = [file("a.md", "y")];
        // B's edit is no later than A's: only ancestry, not edit time, keeps A from reverting it.
        expect(yield* b.sync({ at: 2 })).toMatchObject({ status: "pushed" });
        expect(yield* a.sync({ at: 2 })).toMatchObject({ status: "pulled", paths: ["a.md"] });
        expect(text(a.files)).toEqual({ "a.md": "y" });
      }),
    );

    it.effect("another device moved first: the sent revision is merged with theirs", () =>
      Effect.gen(function* () {
        const registry = makeRegistry();
        const a = yield* makeDevice(registry, [file("a.md", "0"), file("b.md", "0")]);
        yield* a.sync({ at: 1 });
        const b = yield* makeDevice(registry, []);
        yield* b.sync({ at: 1 });
        b.files = [file("a.md", "0"), file("b.md", "b")];
        registry.registry.before.move = () => {
          registry.registry.before.move = () => Effect.void;
          return Effect.fail(new RemoteDown({ step: "move" }));
        };
        yield* Effect.flip(b.sync({ at: 2 }));
        const sent = b.state._tag === "Sending" ? b.state.revision : undefined;
        a.files = [file("a.md", "a"), file("b.md", "0")];
        yield* a.sync({ at: 3 });
        // B also edited after its send was interrupted.
        b.files = [file("a.md", "0"), file("b.md", "b"), file("c.md", "c")];
        expect(yield* b.sync({ at: 4 })).toMatchObject({ status: "merged" });
        expect(text(b.files)).toEqual({ "a.md": "a", "b.md": "b", "c.md": "c" });
        const current = registry.registry.revisions.get(registry.registry.current!)!;
        const ours = registry.registry.revisions.get(current.revision.parents[1]!)!;
        expect(ours.revision.parents).toEqual([sent]);
      }),
    );
  });

  it.effect("a retried push records the same revision once", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "1")]);
      registry.registry.after.post = () => {
        registry.registry.after.post = () => Effect.void;
        return Effect.fail(new RemoteDown({ step: "post" }));
      };
      yield* Effect.flip(a.sync({ at: 1 }));
      // The post landed but its response was lost; the state was not yet Sending.
      expect(a.state).toEqual(Sync.Idle.make({ base: null }));
      expect(registry.registry.posts).toBe(1);
      yield* a.sync({ at: 1 });
      expect(registry.registry.posts).toBe(1);
      expect(registry.registry.revisions.has(registry.registry.current!)).toBe(true);
    }),
  );

  it.effect("a bulk removal blocks until that exact removal is approved", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "1")]);
      yield* a.sync({ at: 1 });
      a.files = [];
      const blocked = yield* a.sync({ at: 2 });
      expect(blocked).toEqual({
        status: "blocked",
        removal: { deleting: 1, of: 1, paths: ["a.md"] },
      });
      expect(registry.registry.revisions.size).toBe(1);
      if (blocked.status !== "blocked") return;
      expect(yield* a.sync({ at: 2, approved: blocked.removal })).toMatchObject({
        status: "pushed",
      });
      expect(registry.registry.revisions.get(registry.registry.current!)!.tree).toEqual([]);
    }),
  );

  it.effect("sync gives up, without losing anything, when other devices never stop moving", () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("a.md", "0")]);
      yield* a.sync({ at: 1 });
      const other = makeMachineId();
      registry.registry.before.move = () =>
        Effect.gen(function* () {
          const n = registry.registry.revisions.size;
          const tree = [file("a.md", `other ${n}`)];
          const revision: History.Revision = {
            tree: yield* History.treeHash(tree),
            parents: [registry.registry.current!],
            author: { device: other, at: 100 + n },
          };
          const id = yield* History.revisionId(revision);
          registry.registry.revisions.set(id, { revision, tree: History.sortTree(tree) });
          registry.registry.current = id;
        }).pipe(Effect.provide(NodeCrypto.layerDigest));
      a.files = [file("a.md", "mine")];
      expect(yield* Effect.flip(a.sync({ at: 2 }))).toMatchObject({ _tag: "Sync.Unsettled" });
      // What the device sent is on the Registry, and its state still names it.
      expect(a.state._tag).toBe("Sending");
      if (a.state._tag === "Sending")
        expect(registry.registry.revisions.has(a.state.revision)).toBe(true);
    }),
  );
});

it.effect(
  "rejects a faulty merger's impossible namespace before posting or preparing Writing",
  () =>
    Effect.gen(function* () {
      const registry = makeRegistry();
      const a = yield* makeDevice(registry, [file("base.txt", "base")]);
      const b = yield* makeDevice(registry, []);
      yield* a.sync({ at: 1 });
      yield* b.sync({ at: 2 });
      a.files = [file("base.txt", "local")];
      b.files = [file("base.txt", "remote")];
      yield* b.sync({ at: 3 });
      const saved = a.saved.length;
      const invalid = [file("notes", "file"), file("notes/a.txt", "child")];
      expect(
        yield* Effect.flip(
          a.sync({
            at: 4,
            merger: () => ({ value: Option.some(invalid), choices: [], conflicts: [] }),
          }),
        ),
      ).toMatchObject({ _tag: "Sync.InvalidTree", path: "notes/a.txt" });
      expect(a.saved.slice(saved).some((state) => state._tag === "Writing")).toBe(false);
      expect(
        [...registry.registry.revisions.values()].some(
          ({ tree }) => History.treePathIssue(tree) !== undefined,
        ),
      ).toBe(false);
      expect(text(a.files)).toEqual({ "base.txt": "local" });
    }),
);
