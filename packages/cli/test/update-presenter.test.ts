import { assert, it } from "@effect/vitest";
import { makeCollectionId, makeRetainedCopyId, makeSkillId } from "@smolai/skit-core";
import { renderContract } from "../src/presentation/contract-presenters.js";

const context = { color: false, detail: "summary" } as const;
const digest = `sha256:${"0".repeat(64)}`;
const changes = {
  label: "mattpocock/skills",
  installed: ["pr"],
  new_available: 0,
  updated: ["tdd"],
  removed: ["zoom-out"],
  kept: ["diagnose"],
};

it("names what an update installs, changes, retires and keeps per Source", () => {
  const output = renderContract(
    "skit.update.v5",
    [
      {
        subject_id: makeCollectionId(),
        subject_kind: "collection",
        previous_retained_copy_id: makeRetainedCopyId(),
        selected_retained_copy_id: makeRetainedCopyId(),
        snapshot_digest: digest,
        changed: true,
        projected: 1,
        deferred: 0,
        ...changes,
      },
      {
        subject_id: makeCollectionId(),
        subject_kind: "collection",
        previous_retained_copy_id: makeRetainedCopyId(),
        selected_retained_copy_id: makeRetainedCopyId(),
        snapshot_digest: digest,
        changed: true,
        projected: 0,
        deferred: 0,
        label: "swyxio/skills",
        installed: [],
        new_available: 6,
        updated: [],
        removed: [],
        kept: [],
      },
    ],
    context,
  );
  assert.strictEqual(
    output,
    [
      "Update complete",
      "mattpocock/skills",
      "  + pr",
      "  ~ tdd",
      "  - zoom-out",
      "  ! diagnose was deleted upstream; kept because it is enabled on its own",
      "swyxio/skills",
      "  6 new Skills available to enable",
      "",
      "2 Sources updated.",
    ].join("\n"),
  );
});

it("previews the same changes without applying them", () => {
  const output = renderContract(
    "skit.update.plan.v5",
    [
      {
        subject_id: makeCollectionId(),
        subject_kind: "collection",
        current_snapshot_digest: digest,
        available_snapshot_digest: `sha256:${"1".repeat(64)}`,
        changed: true,
        ...changes,
      },
    ],
    context,
  );
  assert.match(output ?? "", /^Update plan\nmattpocock\/skills · update available\n {2}\+ pr\n/);
  assert.match(output ?? "", /No changes applied; run `skit update` to apply\.$/);
});

it("lists whole-Collection and individual enables distinctly", () => {
  const collectionId = makeCollectionId();
  const skillId = makeSkillId();
  const output = renderContract(
    "skit.list.v4",
    {
      subjects: [
        {
          subject_id: collectionId,
          subject_kind: "collection",
          label: "tim/skills",
          skills: [{ name: "council", skill_id: skillId, versions: [] }],
        },
      ],
      bindings: [
        {
          harness: "codex",
          entries: [
            { kind: "collection", collection_id: collectionId, label: "tim/skills" },
            { kind: "skill", skill_id: skillId, name: "effect" },
          ],
          skills: [skillId],
        },
      ],
    },
    context,
  );
  assert.match(output ?? "", /\ncodex: tim\/skills \(whole Collection\), effect$/);
});
