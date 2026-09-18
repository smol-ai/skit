import { Effect, FileSystem } from "effect";
import { dirname, join } from "node:path";
import { copyLocalTreeEffect } from "../platform/copy-tree.js";
import { deterministicTreeHashEffect } from "../artifact/skit.js";

export const PLAIN_SKILL_PROJECTION_PROFILE = "plain-skill-layout/v1" as const;

/** Change only directory layout; every projected file and symlink comes from retained bytes. */
export const plainSkillProjectionDigestEffect = Effect.fn("Library.plainSkillProjectionDigest")(
  function* (
    verbatimRoot: string,
    skills: readonly {
      verbatim_path: string;
      projected_path: string;
    }[],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "skit-plain-skill-projection-" });
    const projected = join(workspace, "projected");
    for (const skill of skills) {
      const source =
        skill.verbatim_path === "." ? verbatimRoot : join(verbatimRoot, skill.verbatim_path);
      const destination =
        skill.projected_path === "." ? projected : join(projected, skill.projected_path);
      yield* fs.makeDirectory(dirname(destination), { recursive: true, mode: 0o700 });
      yield* copyLocalTreeEffect(source, destination, undefined, true);
    }
    if (skills.length === 0) yield* fs.makeDirectory(projected, { mode: 0o700 });
    return yield* deterministicTreeHashEffect(projected);
  },
);
