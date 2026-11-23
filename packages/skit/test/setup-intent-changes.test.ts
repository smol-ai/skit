import { inverseSetResult, reverseFullSetupIntent } from "./helpers/setup-intent-reference.js";
import { edit } from "../src/library/library-edit.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { prepareSetupChanges, prepareSetupProgress } from "../src/library/store/setup-intent.js";
import { setupIntent } from "../src/library/store/intent.js";
import { reverseSetupIntent } from "../src/library/internal/setup/undo-intent.js";
import {
  decodeLibraryState,
  emptyLibraryState,
  type LibraryState,
} from "../src/library/library-state.js";
import { canonicalJson } from "../src/shared/json.js";
import { fixture } from "./helpers/library-values.js";

it.effect("progress can cancel device changes without treating unknown fields as intent", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const skill = state.skills[0]!;
    const before = yield* decodeLibraryState({
      ...state,
      device_skill_selection: {
        mode: "choose",
        enabled: [],
        invocation_policies: {},
        extension: { keep: [null, {}, []] },
      },
    });
    const after = yield* decodeLibraryState({
      ...before,
      device_skill_selection: {
        ...before.device_skill_selection,
        mode: "choose",
        enabled: [{ skill: skill.skill_id }],
      },
    });
    const changes = yield* prepareSetupChanges(setupIntent(before), setupIntent(after), "fixture");
    const cancelled = yield* prepareSetupProgress(
      changes,
      setupIntent(after),
      setupIntent(before),
      "fixture",
    );
    assert.deepStrictEqual(cancelled.scopes, []);
    const current: LibraryState = { ...before, device_skill_selection: { mode: "follow-account" } };
    const inverse = reverseSetupIntent(current, cancelled);
    assert.strictEqual(canonicalJson(inverse.state), canonicalJson(current));
    assert.deepStrictEqual(inverse.conflicts, []);
    assert.isFalse(inverse.changed);
  }),
);

it.effect(
  "membership evidence uses the original follow even when this setup enabled it earlier",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const collection = state.collections[0]!.collection_id;
      const first = state.skills[0]!.skill_id,
        second = state.skills[1]!.skill_id;
      const before = {
        ...setupIntent(state),
        global: { enabled: [] },
        repositories: [],
        device: null,
        memberships: [{ collectionId: collection, skillIds: [first] }],
      };
      const enabled = { ...before, global: { enabled: [{ collection }] } };
      const after = {
        ...enabled,
        memberships: [{ collectionId: collection, skillIds: [first, second] }],
      };
      const initial = yield* prepareSetupChanges(before, enabled, "fixture");
      const changes = yield* prepareSetupProgress(initial, enabled, after, "fixture");
      assert.strictEqual(changes.memberships[0]?.followedBefore, false);
    }),
);

it.effect("empty and absent policy sets record no changed key", () =>
  Effect.gen(function* () {
    const before: LibraryState = { ...emptyLibraryState(), invocation_policies: {} };
    const after = emptyLibraryState();
    const changes = yield* prepareSetupChanges(setupIntent(before), setupIntent(after), "fixture");
    assert.deepStrictEqual(changes.scopes, []);
    const inverse = reverseSetupIntent(before, changes);
    assert.deepStrictEqual(inverse.conflicts, []);
    assert.isFalse(Object.hasOwn(inverse.state, "invocation_policies"));
    assert.isFalse(inverse.changed);
  }),
);

it.effect(
  "changed policies keep original conflict order when a changed value and a removal both conflict",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const first = state.skills[0]!.skill_id,
        second = state.skills[1]!.skill_id;
      const before: LibraryState = {
        ...state,
        enabled: [{ skill: first }, { skill: second }],
        invocation_policies: { [first]: "explicit", [second]: "explicit" },
      };
      const after: LibraryState = { ...before, invocation_policies: { [first]: "implicit" } };
      const current: LibraryState = {
        ...after,
        invocation_policies: { [first]: "host-policy", [second]: "implicit" },
      };
      const changes = yield* prepareSetupChanges(
        setupIntent(before),
        setupIntent(after),
        "fixture",
      );
      const inverse = reverseSetupIntent(current, changes);
      assert.deepStrictEqual(
        inverse.conflicts.map(canonicalJson).sort(),
        [
          { _tag: "SelectionChanged", scope: { _tag: "Account" }, key: first, kind: "invocation" },
          { _tag: "SelectionChanged", scope: { _tag: "Account" }, key: second, kind: "invocation" },
        ]
          .map(canonicalJson)
          .sort(),
      );
      assert.deepStrictEqual(inverse.state.invocation_policies, current.invocation_policies);
    }),
);

it.effect("separate saves disabling A then B preserve enabled and policy conflict order", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const first = state.skills[0]!.skill_id,
      second = state.skills[1]!.skill_id;
    const before: LibraryState = {
      ...state,
      enabled: [{ skill: first }, { skill: second }],
      invocation_policies: { [first]: "explicit", [second]: "explicit" },
    };
    const middle = (yield* edit(before, {
      _tag: "Enabled",
      changes: [
        { _tag: "Disable", subject: { _tag: "Skill", id: first }, where: [{ kind: "global" }] },
      ],
    })).next;
    const after = (yield* edit(middle, {
      _tag: "Enabled",
      changes: [
        { _tag: "Disable", subject: { _tag: "Skill", id: second }, where: [{ kind: "global" }] },
      ],
    })).next;
    const initial = yield* prepareSetupChanges(setupIntent(before), setupIntent(middle), "fixture");
    const changes = yield* prepareSetupProgress(
      initial,
      setupIntent(middle),
      setupIntent(after),
      "fixture",
    );
    assert.deepStrictEqual(
      changes.scopes[0]?.enabled.find((row) => row.key === `skill:${first}`)?.before,
      initial.scopes[0]?.enabled[0]?.before,
    );
    const full = reverseFullSetupIntent(after, setupIntent(before), setupIntent(after));
    const compact = reverseSetupIntent(after, changes);
    assert.deepStrictEqual(inverseSetResult(compact), inverseSetResult(full));
    assert.deepStrictEqual(compact.state.enabled, before.enabled);
    const policyMiddle: LibraryState = { ...before, invocation_policies: { [second]: "explicit" } };
    const policyAfter: LibraryState = { ...before, invocation_policies: { [second]: "implicit" } };
    const current: LibraryState = {
      ...policyAfter,
      invocation_policies: { [first]: "host-policy", [second]: "host-policy" },
    };
    const policies = yield* prepareSetupProgress(
      yield* prepareSetupChanges(setupIntent(before), setupIntent(policyMiddle), "fixture"),
      setupIntent(policyMiddle),
      setupIntent(policyAfter),
      "fixture",
    );
    assert.deepStrictEqual(
      inverseSetResult(reverseSetupIntent(current, policies)),
      inverseSetResult(
        reverseFullSetupIntent(current, setupIntent(before), setupIntent(policyAfter)),
      ),
    );
  }),
);

it.effect("separate repository removals retain the full inverse's scope order", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const skill = state.skills[0]!.skill_id;
    const before: LibraryState = {
      ...state,
      enabled: [],
      repositories: [
        { root: "/first", enabled: [{ skill }] },
        { root: "/second", enabled: [{ skill }] },
      ],
    };
    const middle = (yield* edit(before, {
      _tag: "Enabled",
      changes: [
        {
          _tag: "Disable",
          subject: { _tag: "Skill", id: skill },
          where: [{ kind: "repository", root: "/second" }],
        },
      ],
    })).next;
    const after = (yield* edit(middle, {
      _tag: "Enabled",
      changes: [
        {
          _tag: "Disable",
          subject: { _tag: "Skill", id: skill },
          where: [{ kind: "repository", root: "/first" }],
        },
      ],
    })).next;
    const changes = yield* prepareSetupProgress(
      yield* prepareSetupChanges(setupIntent(before), setupIntent(middle), "fixture"),
      setupIntent(middle),
      setupIntent(after),
      "fixture",
    );
    const full = reverseFullSetupIntent(after, setupIntent(before), setupIntent(after));
    const compact = reverseSetupIntent(after, changes);
    assert.deepStrictEqual(inverseSetResult(compact), inverseSetResult(full));
  }),
);
