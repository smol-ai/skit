// How every Library change is planned and applied: plan from the Snapshot the front end showed;
// apply only while the Library is still that Snapshot and planning again gives the same plan.

import { Effect } from "effect";
import { InvalidLibraryState } from "../failures.js";
import { sha256Hash } from "../shared/hash.js";
import { canonicalJson } from "../shared/json.js";
import { emptyLibraryState, LibraryState } from "./library-state.js";
import { StalePlan } from "./library-plan.js";
import { Revision, snapshotOf, type Snapshot } from "./snapshot.js";
import {
  libraryStatePath,
  writeLibrary,
  type LibraryWriter,
  inspectLocalLibraryState,
} from "./store/library-store.js";

/** The state to plan from: the displayed Snapshot, refused unless it is what it claims to be. */
export const planningState = Effect.fn("Library.planningState")(function* (
  home: string,
  displayed: Snapshot,
) {
  const base = structuredClone(displayed);
  if (base._tag !== "Present" && base._tag !== "Absent")
    return yield* new StalePlan({ message: "Planning requires the displayed Library snapshot" });
  const state = base._tag === "Present" ? base.state : emptyLibraryState();
  yield* LibraryState.makeEffect(state).pipe(
    Effect.mapError(
      () =>
        new InvalidLibraryState({
          path: libraryStatePath(home),
          detail: "invalid Library snapshot",
        }),
    ),
  );
  const actual = snapshotOf(
    base._tag === "Present" ? { present: true, state } : { present: false },
  ).revision;
  if (base.revision !== actual)
    return yield* new StalePlan({
      message: "The displayed Library snapshot changed",
      expected: base.revision,
      actual,
    });
  return state;
});

/** A plan's identity: the hash of everything it was reviewed with, encoded. */
export const planIdOf = (reviewed: unknown) =>
  sha256Hash(new TextEncoder().encode(canonicalJson(reviewed)));

/**
 * Apply a reviewed plan inside a Library write. Refuses it unless the Library is still the one it
 * was planned from and planning again from it gives exactly the plan handed in; then applies the
 * plan made just now, never the one the caller handed in.
 */
export const applyReviewed = <
  P extends { readonly baseRevision: string; readonly planId: string },
  A,
  E1,
  R1,
  E2,
  R2,
>(
  home: string,
  plan: P,
  replan: (base: Snapshot) => Effect.Effect<P, E1, R1>,
  apply: (again: P, base: Snapshot) => Effect.Effect<A, E2, R2 | LibraryWriter>,
) =>
  writeLibrary(
    home,
    Effect.gen(function* () {
      const base = snapshotOf(yield* inspectLocalLibraryState(home));
      if (base.revision !== plan.baseRevision)
        return yield* new StalePlan({
          message: "The Library changed after this plan was reviewed",
          expected: Revision.make(plan.baseRevision),
          actual: base.revision,
        });
      const again = yield* replan(base);
      // Planning again must give exactly the plan handed in, not merely its id.
      if (again.planId !== plan.planId || canonicalJson(again) !== canonicalJson(plan))
        return yield* new StalePlan({ message: "The Library differs from the reviewed plan" });
      return yield* apply(again, base);
    }),
  );
