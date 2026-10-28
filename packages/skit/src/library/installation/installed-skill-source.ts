import { Clock, Effect } from "effect";
import { join } from "node:path";
import { validateSkitDirectory } from "../../artifact/skit.js";
import { originalTreeHash, collectionVersionPath } from "../collection-version.js";
import { versionBacking, type Skill, type SkillVersion } from "../library-contracts.js";
import type { LibraryState } from "../library-state.js";

/**
 * What one retained Skill Version installs from, read from its verified retained original. An
 * `invalid` source cannot be installed; a missing original fails as the filesystem reports it.
 */
export const installedSkillSource = Effect.fn("Library.installedSkillSource")(function* (
  state: LibraryState,
  originalsPath: string,
  skill: Skill,
  version: SkillVersion,
) {
  const backing = versionBacking(state, skill, version);
  if (backing === undefined)
    return { kind: "invalid" as const, detail: `retained Skill ${skill.name} has no backing` };
  const root = collectionVersionPath(originalsPath, backing.copy.hash);
  const authored = version.materialization_profile === "declared-skit-skill/v1";
  const validated = authored
    ? yield* validateSkitDirectory(root, "retained", {
        assessmentContext: "project",
        acceptances: state.assessmentAcceptances ?? [],
        evaluatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      })
    : undefined;
  if (validated?.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { kind: "invalid" as const, detail: "retained authored descriptor is invalid" };
  const descriptorSkill = validated?.descriptor.skills.find(
    (candidate) => candidate.name === skill.name,
  );
  if (authored && descriptorSkill === undefined)
    return { kind: "invalid" as const, detail: `authored descriptor lacks ${skill.name}` };
  const importedPath =
    backing.member.source_path === "." ? root : join(root, backing.member.source_path);
  if ((yield* originalTreeHash(importedPath)) !== version.source_hash)
    return { kind: "invalid" as const, detail: `retained Skill ${skill.name} changed` };
  return {
    kind: "source" as const,
    libraryPath: root,
    sourcePath: descriptorSkill === undefined ? importedPath : join(root, descriptorSkill.path),
    ...(descriptorSkill === undefined
      ? {}
      : { shared: descriptorSkill.shared, declaredInvocation: descriptorSkill.invocation }),
  };
});
