import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeRemovalCheck, scanAuthorInventory } from "../src/author/inventory.js";

const baseline = {
  inventory: { files: ["a", "b", "c"], members: ["one", "two"] },
  removedFiles: [],
  removedMembers: [],
};
const smaller = {
  inventory: { files: ["a", "b"], members: ["one", "two"] },
  membershipReadable: true,
};

it.effect(
  "requires two observations ten monotonic seconds apart and resets after unreadability",
  () =>
    Effect.gen(function* () {
      const owner = makeRemovalCheck();
      expect((yield* owner.check("w", baseline, smaller)).decision.status).toBe("waiting");
      yield* TestClock.adjust("9 seconds");
      expect((yield* owner.check("w", baseline, smaller)).decision.status).toBe("waiting");
      yield* owner.reset("w");
      yield* TestClock.adjust("2 seconds");
      expect((yield* owner.check("w", baseline, smaller)).decision.status).toBe("waiting");
      yield* TestClock.adjust("10 seconds");
      expect((yield* owner.check("w", baseline, smaller)).decision.status).toBe("accepted");
      expect((yield* makeRemovalCheck().check("w", baseline, smaller)).decision.status).toBe(
        "waiting",
      );
    }),
);

it.effect("the union of file and member bulk checks never ages into permission", () =>
  Effect.gen(function* () {
    const owner = makeRemovalCheck();
    const observed = {
      inventory: { files: baseline.inventory.files, members: [] },
      membershipReadable: true,
    };
    expect((yield* owner.check("w", baseline, observed)).decision.status).toBe("blocked");
    yield* TestClock.adjust("1 hour");
    expect((yield* owner.check("w", baseline, observed)).decision.status).toBe("blocked");
    expect((yield* owner.check("w", baseline, observed, true)).decision.status).toBe("accepted");
    const changed = { inventory: { files: [], members: [] }, membershipReadable: true };
    expect((yield* owner.check("w", baseline, changed)).decision.status).toBe("blocked");
  }),
);

it.effect(
  "pending observations do not reduce the accepted baseline; safe additions do advance",
  () =>
    Effect.gen(function* () {
      const owner = makeRemovalCheck();
      const observed = {
        ...smaller,
        inventory: { ...smaller.inventory, files: ["a", "b", "new"] },
      };
      const result = yield* owner.check("w", baseline, observed);
      expect(result.accepted.inventory.files).toEqual(["a", "b", "c", "new"]);
      expect(result.decision.heldFiles).toEqual(["c"]);
      expect(
        (yield* owner.check("w", baseline, { ...observed, membershipReadable: false }, true))
          .decision.status,
      ).toBe("waiting");
    }),
);

it.effect("missing plain-folder primaries and malformed descriptors retain membership", () =>
  Effect.gen(function* () {
    const missing = yield* scanAuthorInventory(
      [{ kind: "directory", path: "one" }],
      baseline.inventory,
    );
    expect(missing.inventory.members).toEqual(["one"]);
    const malformed = yield* scanAuthorInventory(
      [{ kind: "file", path: "skit.json", mode: 0o644, bytes: new TextEncoder().encode("{") }],
      baseline.inventory,
    );
    expect(malformed.membershipReadable).toBe(false);
    expect(malformed.inventory.members).toEqual(baseline.inventory.members);
  }),
);

it.effect(
  "unknown absences grant no removal permission; confirmed permission survives later passes",
  () =>
    Effect.gen(function* () {
      const owner = makeRemovalCheck();
      const first = yield* owner.check("w", undefined, smaller);
      expect(first.decision.removedFiles).toEqual([]);
      const waiting = yield* owner.check("w", first.accepted, smaller, false, baseline.inventory);
      expect(waiting.decision.heldFiles).toEqual(["c"]);
      yield* TestClock.adjust("10 seconds");
      const approved = yield* owner.check("w", waiting.accepted, smaller);
      expect(approved.decision.removedFiles).toEqual(["c"]);
      expect(
        (yield* owner.check("w", approved.accepted, smaller, false, baseline.inventory)).decision
          .removedFiles,
      ).toEqual(["c"]);
      const restored = yield* owner.check("w", approved.accepted, {
        inventory: baseline.inventory,
        membershipReadable: true,
      });
      expect(restored.decision.removedFiles).toEqual([]);
    }),
);

it.effect("verbatim history and normalized sync inputs use identical inventory keys", () =>
  Effect.gen(function* () {
    const entry = {
      kind: "file" as const,
      path: "review/café.txt",
      mode: 0o644 as const,
      bytes: new Uint8Array([1]),
    };
    expect((yield* scanAuthorInventory([entry], undefined)).inventory).toEqual(
      (yield* scanAuthorInventory([{ ...entry, path: entry.path.normalize("NFC") }], undefined))
        .inventory,
    );
  }),
);
