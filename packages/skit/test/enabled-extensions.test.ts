import { LibraryStateFields } from "../src/library/store/state-fields.js";
import { assert, it } from "@effect/vitest";
import { Effect, Schema, Struct } from "effect";
import { fixture } from "./helpers/library-values.js";
import {
  decodeLibraryState,
  prepareLibrarySets,
  LibraryState,
} from "../src/library/library-state.js";
import {
  setEnabledAt,
  remapEnabled,
  removeFromEnabled,
  prepareEnabledSet,
} from "../src/library/enabled.js";
import { makeCollectionId, makeSkillId } from "../src/library/entity-ids.js";
import { canonicalJson } from "../src/shared/json.js";

const selectionFields = Schema.Struct(
  Struct.pick(LibraryStateFields, [
    "enabled",
    "invocation_policies",
    "repositories",
    "device_skill_selection",
  ]),
);
const selectionJson = (state: unknown) => {
  const value = Schema.decodeUnknownSync(Schema.declare(Schema.is(selectionFields)))(state);
  const current = prepareEnabledSet(value);
  return canonicalJson({
    enabled: current.enabled,
    invocation_policies: current.invocation_policies,
    repositories: current.repositories
      .map(prepareEnabledSet)
      .sort((a, b) => a.root.localeCompare(b.root)),
    device_skill_selection:
      current.device_skill_selection?.mode === "choose"
        ? prepareEnabledSet(current.device_skill_selection)
        : current.device_skill_selection,
  });
};

it.effect("changing a repository or device choice preserves its uninterpreted fields", () =>
  Effect.gen(function* () {
    const { state } = yield* fixture;
    const repository = state.repositories[0];
    const selection = state.device_skill_selection;
    if (!repository || selection?.mode !== "choose") return yield* Effect.die("Missing scope");
    const { invocation_policies: _policies, ...kept } = repository;
    assert.strictEqual(
      selectionJson(
        setEnabledAt(state, { kind: "repository", root: repository.root }, { enabled: [] }),
      ),
      selectionJson({ ...state, repositories: [{ ...kept, enabled: [] }] }),
    );
    const { invocation_policies: _devicePolicies, ...device } = selection;
    assert.strictEqual(
      selectionJson(setEnabledAt(state, { kind: "global" }, { enabled: [] })),
      selectionJson({ ...state, device_skill_selection: { ...device, enabled: [] } }),
    );
  }),
);

it.effect(
  "identity remapping and removal preserve extensions on surviving enabled items and scopes",
  () =>
    Effect.gen(function* () {
      const { state } = yield* fixture;
      const first = state.skills[0],
        second = state.skills[1];
      if (!first || !second) return yield* Effect.die("Missing Skills");
      const list = {
        enabled: [
          { skill: first.skill_id, extension: { absent: null } },
          { collection: first.collection_id, extension: { sequence: [2, 1] } },
          { skill: second.skill_id, extension: { kept: true } },
        ],
        invocation_policies: { [first.skill_id]: "explicit" },
      };
      const before = yield* decodeLibraryState({
        ...state,
        ...list,
        repositories: [{ root: "/repo", extension: { scope: "repository" }, ...list }],
        device_skill_selection: { mode: "choose", extension: { scope: "device" }, ...list },
      });
      const skill = makeSkillId(),
        collection = makeCollectionId();
      const mapped = {
        enabled: [
          { ...list.enabled[0], skill },
          { ...list.enabled[1], collection },
          list.enabled[2],
        ],
        invocation_policies: { [skill]: "explicit" },
      };
      assert.strictEqual(
        selectionJson(
          remapEnabled(before, {
            skills: [{ from: first.skill_id, to: skill }],
            collections: [{ from: first.collection_id, to: collection }],
          }),
        ),
        selectionJson({
          ...state,
          ...mapped,
          repositories: [{ root: "/repo", extension: { scope: "repository" }, ...mapped }],
          device_skill_selection: { mode: "choose", extension: { scope: "device" }, ...mapped },
        }),
      );
      const { invocation_policies: _oldPolicies, ...withoutPolicies } = state;
      assert.strictEqual(
        selectionJson(
          removeFromEnabled(before, {
            skills: new Set([first.skill_id]),
            collections: new Set([first.collection_id]),
          }),
        ),
        selectionJson({
          ...withoutPolicies,
          enabled: [list.enabled[2]],
          repositories: [
            { root: "/repo", extension: { scope: "repository" }, enabled: [list.enabled[2]] },
          ],
          device_skill_selection: {
            mode: "choose",
            extension: { scope: "device" },
            enabled: [list.enabled[2]],
          },
        }),
      );
    }),
);
