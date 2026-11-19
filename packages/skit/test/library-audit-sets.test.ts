import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { diffLibraryState } from "../src/library/audit/state-diff.js";
import {
  decodeLibraryState,
  emptyLibraryState,
  libraryStateRevision,
} from "../src/library/library-state.js";
import { fixture } from "./helpers/library-values.js";

for (const changed of [false, true])
  it.effect(
    changed
      ? "audit records changed invocation values"
      : "audit ignores invocation policy key order",
    () =>
      Effect.gen(function* () {
        const { state } = yield* fixture;
        const first = state.skills[0]!.skill_id,
          second = state.skills[1]!.skill_id;
        const before = yield* decodeLibraryState({
          ...state,
          enabled: [{ skill: first }, { skill: second }],
          invocation_policies: { [first]: "explicit", [second]: "implicit" },
        });
        const after = yield* decodeLibraryState({
          ...before,
          invocation_policies: { [second]: "implicit", [first]: changed ? "implicit" : "explicit" },
        });
        assert.deepStrictEqual(
          diffLibraryState(before, after),
          changed ? [{ entity: "binding", id: "global", action: "invocation-changed" }] : [],
        );
        assert.strictEqual(libraryStateRevision(before) === libraryStateRevision(after), !changed);
      }),
  );

it.effect("audit treats an empty policy container as the empty set", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(
      diffLibraryState({ ...emptyLibraryState(), invocation_policies: {} }, emptyLibraryState()),
      [],
    );
  }),
);
