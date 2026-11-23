import { prepareSetupChanges } from "../src/library/store/setup-intent.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { canonicalJson } from "../src/shared/json.js";
import { decodeLibraryState, emptyLibraryState } from "../src/library/library-state.js";
import { setupIntent } from "../src/library/store/intent.js";
import { reverseSetupIntent } from "../src/library/internal/setup/undo-intent.js";
import { fixture } from "./helpers/library-values.js";

it.effect("Undo leaves an unchanged choose selection exactly as the current Library holds it", () =>
  Effect.gen(function* () {
    const state = yield* decodeLibraryState({
      ...emptyLibraryState(),
      device_skill_selection: {
        mode: "choose",
        enabled: [],
        invocation_policies: {},
        extension: { keep: [null, {}, []] },
      },
    });
    const inverse = reverseSetupIntent(
      state,
      yield* prepareSetupChanges(setupIntent(state), setupIntent(state), "fixture"),
    );
    assert.strictEqual(canonicalJson(inverse.state), canonicalJson(state));
    assert.deepStrictEqual(inverse.conflicts, []);
    assert.isFalse(inverse.changed);
  }),
);

it.effect("Undo reverses a choose selection while keeping its other current fields", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const first = state.skills[0]!;
    const second = state.skills[1]!;
    const before = yield* decodeLibraryState({
      ...state,
      device_skill_selection: { mode: "choose", enabled: [{ skill: first.skill_id }] },
    });
    const after = yield* decodeLibraryState({
      ...before,
      device_skill_selection: {
        mode: "choose",
        enabled: [{ skill: first.skill_id }, { skill: second.skill_id }],
        extension: { keep: [null, {}, []] },
      },
    });
    const inverse = reverseSetupIntent(
      after,
      yield* prepareSetupChanges(setupIntent(before), setupIntent(after), "fixture"),
    );
    assert.strictEqual(
      canonicalJson(inverse.state.device_skill_selection),
      canonicalJson({
        mode: "choose",
        enabled: [{ skill: first.skill_id }],
        extension: { keep: [null, {}, []] },
      }),
    );
    assert.deepStrictEqual(inverse.conflicts, []);
    assert.isTrue(inverse.changed);
  }),
);
