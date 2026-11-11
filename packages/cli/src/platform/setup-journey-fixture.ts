import { pinnedCollections } from "./storybook-fixtures.js";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";

// Real skills from the Collections pinned in test/fixtures/collections/manifest.json, placed where
// an agent installed them before SKIT was set up. Claude Code reaches nvidia-skill-finder through a
// symlink into ~/.agents/skills, the way skills.sh shares one install between agents.
const installed = [
  { collection: "swyxio", path: "cli-ux", root: ".agents" },
  { collection: "swyxio", path: "skill-cutter", root: ".agents" },
  { collection: "asmartbear", path: ".claude/skills/asb-positioning", root: ".claude" },
  { collection: "asmartbear", path: ".claude/skills/asb-problem", root: ".claude" },
  { collection: "nvidia", path: "skills/nvidia-skill-finder", root: ".agents" },
] as const;

/** A disposable account whose agent skills folders already hold real skills. */
export const makeSetupJourneyFixture = Effect.fn("Storybook.makeSetupJourneyFixture")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const collections = yield* pinnedCollections;
  const account = root;
  for (const skill of installed) {
    const name = skill.path.slice(skill.path.lastIndexOf("/") + 1);
    const skills = join(account, skill.root, "skills");
    yield* fs.makeDirectory(skills, { recursive: true });
    yield* fs.copy(join(collections, skill.collection, skill.path), join(skills, name));
  }
  yield* fs.symlink(
    join(account, ".agents", "skills", "nvidia-skill-finder"),
    join(account, ".claude", "skills", "nvidia-skill-finder"),
  );
  return {
    home: join(root, "library"),
    skillsStateHome: join(root, "state"),
    inventory: {
      home: account,
      configHome: join(account, ".config"),
      overrides: {
        codex: [join(account, ".agents", "skills")],
        "claude-code": [join(account, ".claude", "skills")],
      },
    },
    /** Whether the skill the journey leaves unselected is still in place. */
    unselectedKept: fs.exists(join(account, ".claude", "skills", "asb-positioning", "SKILL.md")),
  };
});
