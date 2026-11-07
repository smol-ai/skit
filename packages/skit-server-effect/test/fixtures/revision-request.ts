import * as History from "@smolai/skit-core/history";
import { MachineId } from "@smolai/skit-core/universal/consumer";
import { Effect, Schema } from "effect";

const text = (value: string) => new TextEncoder().encode(value);

export const device = Schema.decodeSync(MachineId)("mach_01h455vb4pex5vsknk084sn02q");

/** A complete, publishable SKIT whose slug is `tools`. */
export const skillTree: History.Tree = [
  {
    path: "skit.json",
    kind: "file",
    mode: 0o644,
    bytes: text(
      JSON.stringify({
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", default_enabled: true }],
      }),
    ),
  },
  {
    path: "skills/review/SKILL.md",
    kind: "file",
    mode: 0o644,
    bytes: text("---\nname: review\n---\n# Review\n"),
  },
];

/** The body a device posts to record `tree` on top of `parents` at time `at`. */
export const revisionRequest = Effect.fn("Fixture.revisionRequest")(function* (
  tree: History.Tree = skillTree,
  parents: ReadonlyArray<History.RevisionId> = [],
  at = 1,
) {
  const revision = { tree: yield* History.treeHash(tree), parents, author: { device, at } };
  return { id: yield* History.revisionId(revision), revision, tree };
});
