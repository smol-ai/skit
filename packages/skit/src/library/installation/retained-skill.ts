/** Library owns retained-version selection and recovery reproducibility. The file adapter
 * receives concrete inputs and constructs bytes; it never chooses from Library histories. */
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { type InstalledSkill } from "../device-state.js";
import { type LibraryState } from "../library-state.js";
import { globalEnabled } from "../enabled.js";
import { installedSkillSource } from "./installed-skill-source.js";
import { copySkill, InstalledSkillFailure } from "../../installed-skills/files.js";
import { losslessTree } from "../../installed-skills/backups.js";
import { readOwnershipMarker } from "../../installed-skills/marker-inspection.js";
import {
  declaredInvocationIntent,
  overrideInvocationIntent,
  type InvocationIntent,
} from "../../installed-skills/policy.js";

/** Rebuild one former copy into caller-owned staging, using the same byte owner as installing. */
export const prepareInstalledSkillRebuild = Effect.fn("Install.prepareRebuild")(function* (
  state: LibraryState,
  originalsPath: string,
  installedSkill: InstalledSkill,
  invocationIntent: InvocationIntent,
) {
  const target = installedSkill.destination;
  const skill = state.skills.find((item) => item.skill_id === installedSkill.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === installedSkill.skill_version_id,
  );
  if (!skill || !version)
    return yield* new InstalledSkillFailure({
      reason: { _tag: "VersionMissing", kind: "former" },
    });
  const retainedPath = yield* Effect.scoped(
    Effect.gen(function* () {
      const source = yield* installedSkillSource(state, originalsPath, skill, version);
      if (source.kind !== "source")
        return yield* new InstalledSkillFailure({ reason: source.reason });
      return source.retainedPath;
    }),
  );
  return {
    collectionVersionPath: retainedPath,
    build: Effect.fn("Install.rebuildBytes")(function* (destination: string) {
      // Retained bytes may have changed since review; validate them again before reading.
      const current = yield* installedSkillSource(state, originalsPath, skill, version);
      if (current.kind !== "source")
        return yield* new InstalledSkillFailure({ reason: current.reason });
      yield* copySkill({
        ...current,
        libraryPath: current.libraryPath,
        destination,
        target,
        invocationIntent,
      });
    }, Effect.scoped),
  };
});

/**
 * Whether a backup is exactly what SKIT would write again, proven only from `prior`, the Library
 * state the mutation loaded: the backup's marker must name the recorded installed skill and Version, that
 * Version's stored original must be intact, and restaging it under a recorded invocation policy
 * must reproduce every name, type, mode and byte. Anything short of that proof keeps the backup.
 */
export const reproducible = Effect.fn("Install.reproducible")(function* (
  backup: string,
  prior: LibraryState,
  originalsPath: string,
  installedSkillId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const recorded = prior.installed_skills.find(
    (item) => item.installed_skill_id === installedSkillId,
  );
  const marker = yield* readOwnershipMarker(backup);
  if (
    recorded === undefined ||
    marker?.installed_skill_id !== recorded.installed_skill_id ||
    marker.skill_id !== recorded.skill_id ||
    marker.skill_version_id !== recorded.skill_version_id
  )
    return false;
  const skill = prior.skills.find((item) => item.skill_id === recorded.skill_id);
  const version = skill?.versions.find(
    (item) => item.skill_version_id === recorded.skill_version_id,
  );
  const target = recorded.destination;
  if (skill === undefined || version === undefined) return false;
  const source = yield* installedSkillSource(prior, originalsPath, skill, version);
  const expected = yield* losslessTree(backup);
  if (source.kind === "invalid" || expected === undefined) return false;
  const policies = new Set(
    [globalEnabled(prior), ...prior.repositories].flatMap((list) => {
      const policy = list.invocation_policies?.[skill.skill_id];
      return policy === undefined ? [] : [policy];
    }),
  );
  for (const invocationIntent of [
    declaredInvocationIntent,
    ...[...policies].map(overrideInvocationIntent),
  ]) {
    const restaged = yield* Effect.scoped(
      Effect.gen(function* () {
        const destination = join(
          yield* fs.makeTempDirectoryScoped({ prefix: "skit-reproduce-" }),
          "skill",
        );
        yield* copySkill({ ...source, target, invocationIntent, destination });
        return yield* losslessTree(destination);
      }),
    );
    if (restaged === expected) return true;
  }
  return false;
}, Effect.scoped);
