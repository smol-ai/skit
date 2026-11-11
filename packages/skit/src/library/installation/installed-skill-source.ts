import { Clock, Effect } from "effect";
import { join } from "node:path";
import { validateSkitDirectory } from "../../artifact/skit.js";
import { originalTreeHash, collectionVersionPath } from "../collection-version.js";
import { versionBacking, type Skill, type SkillVersion } from "../library-contracts.js";
import type { LibraryState } from "../library-state.js";
import { readCollectionVersion } from "../internal/content/read-collection-version.js";

/**
 * What one retained Skill Version installs from, read from its verified retained original. An
 * `invalid` source cannot be installed; the read boundary reports damaged retained storage.
 */
export const installedSkillSource = Effect.fn("Library.installedSkillSource")(function* (
  state: LibraryState,
  originalsPath: string,
  skill: Skill,
  version: SkillVersion,
) {
  const backing = versionBacking(state, skill, version);
  if (backing === undefined)
    return {
      kind: "invalid" as const,
      reason: { _tag: "BackingMissing" as const, skillName: skill.name },
    };
  const retainedPath = collectionVersionPath(originalsPath, backing.copy.hash);
  const root = yield* readCollectionVersion(originalsPath, backing.copy.hash);
  const authored = version.materialization_profile === "declared-skit-skill/v1";
  const validated = authored
    ? yield* validateSkitDirectory(root, "retained", {
        assessmentContext: "project",
        acceptances: state.assessmentAcceptances ?? [],
        evaluatedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      })
    : undefined;
  if (validated?.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    return { kind: "invalid" as const, reason: { _tag: "DescriptorInvalid" as const } };
  const descriptorSkill = validated?.descriptor.skills.find(
    (candidate) => candidate.name === skill.name,
  );
  if (authored && descriptorSkill === undefined)
    return {
      kind: "invalid" as const,
      reason: { _tag: "DescriptorSkillMissing" as const, skillName: skill.name },
    };
  const importedPath =
    backing.member.source_path === "." ? root : join(root, backing.member.source_path);
  if ((yield* originalTreeHash(importedPath)) !== version.source_hash)
    return {
      kind: "invalid" as const,
      reason: { _tag: "ContentChanged" as const, skillName: skill.name },
    };
  // The primary directory hash excludes shared inputs. The validated Skill identity covers
  // the complete projected artifact, including current shared mappings and their file bytes.
  const validatedSkill = validated?.identity.skills.find(
    (candidate) => candidate.name === skill.name,
  );
  if (authored && validatedSkill?.contentHash !== version.validation_identity_hash)
    return {
      kind: "invalid" as const,
      reason: { _tag: "InputsChanged" as const, skillName: skill.name },
    };
  return {
    kind: "source" as const,
    libraryPath: root,
    // Recovery records this stable reference, never a borrowed materialization's lifetime.
    retainedPath,
    sourcePath: descriptorSkill === undefined ? importedPath : join(root, descriptorSkill.path),
    ...(descriptorSkill === undefined
      ? {}
      : { shared: descriptorSkill.shared, declaredInvocation: descriptorSkill.invocation }),
  };
});
