import { join, resolve } from "node:path";
import { Clock, Effect, FileSystem } from "effect";
import {
  canonicalJson,
  currentSkillVersion,
  deterministicTreeHash,
  hashParts,
  LibraryStore,
  prepareInstalledSkillRebuild,
  installEnabledSkills,
  importEdit,
  globalEnabled,
} from "@smolai/skit-core";
import type { InstalledSkillChange, SetupVersionChoice } from "./setup-contract.js";
import { captureSetupFile } from "../../library-application/setup-operation.js";
import { prepareOwnedRecoveryMoves } from "../../library-application/recovery-moves.js";
import { checkSetupGlobalContent } from "../../library-application/setup-external-ownership.js";
import { PlanIsStale } from "../../library/failures.js";

/** Alternatives are derived once by the application; adapters only select these values. */
export const setupVersionAlternatives = (facts: readonly InstalledSkillChange[]) => {
  const skills = [
    ...new Set(facts.filter((fact) => fact.status === "competing").map((fact) => fact.skillId)),
  ];
  return skills.flatMap((skillId) => {
    const copies = facts.filter((fact) => fact.skillId === skillId);
    if (copies.some((fact) => fact.status === "protected")) return [];
    return [
      { skillId, version: "retained" as const },
      ...copies
        .filter((fact) => fact.currentHash !== undefined)
        .map((fact) => ({
          skillId,
          version: "local" as const,
          path: fact.path,
        })),
    ];
  });
};

/** Setup owns the writer and inverse record. This owner preserves every reviewed live copy. */
export const applyChosenSetupVersions = Effect.fn("Setup.applyChosenVersions")(function* (
  facts: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[],
  operationDirectory: string,
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const state = yield* store.load;
  const selected = new Set(choices.map((choice) => choice.skillId));
  const live = facts.filter(
    (fact) => selected.has(fact.skillId) && fact.status !== "native-delete",
  );
  const alternatives = setupVersionAlternatives(facts);
  if (
    selected.size !== choices.length ||
    choices.some(
      (choice) =>
        !alternatives.some((alternative) => canonicalJson(alternative) === canonicalJson(choice)),
    )
  )
    return yield* new PlanIsStale();
  // Check the entire choice before the first retention, rename or install.
  for (const fact of live) {
    const installedSkill = state.installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
    );
    const skill = state.skills.find((item) => item.skill_id === fact.skillId);
    if (
      !installedSkill ||
      !skill ||
      installedSkill.path !== fact.path ||
      currentSkillVersion(state, skill)?.skill_version_id !== fact.desiredVersionId ||
      hashParts([canonicalJson(yield* captureSetupFile(resolve(fact.path)))]) !== fact.evidence
    )
      return yield* new PlanIsStale();
    yield* checkSetupGlobalContent(fact.path);
  }
  for (const choice of choices) {
    if (choice.version !== "local") continue;
    const copy = live.find((fact) => fact.path === choice.path && fact.skillId === choice.skillId);
    if (!copy?.currentHash) return yield* new PlanIsStale();
    yield* Effect.scoped(
      importEdit({
        skillId: copy.skillId,
        installedSkillId: copy.installedSkillId,
        path: copy.path,
        observedHash: copy.currentHash,
        importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      }),
    );
  }
  const imported = yield* store.load;
  // Render all selected destinations before displacing any of them. This also uses their policy.
  const desired = new Map<string, string>();
  for (const fact of live) {
    const installedSkill = imported.installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
    )!;
    const skill = imported.skills.find((item) => item.skill_id === fact.skillId)!;
    const version = currentSkillVersion(imported, skill)!;
    const policy = globalEnabled(imported).invocation_policies?.[fact.skillId];
    const digest = yield* Effect.scoped(
      Effect.gen(function* () {
        const renderer = yield* prepareInstalledSkillRebuild(
          imported,
          store.originalsPath,
          { ...installedSkill, skill_version_id: version.skill_version_id },
          policy === undefined ? { source: "declared" } : { source: "override", policy },
        );
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-choice-" });
        const path = join(directory, "skill");
        yield* renderer.build(path);
        return yield* deterministicTreeHash(path);
      }),
    );
    desired.set(fact.installedSkillId, digest);
  }
  const backup = yield* prepareOwnedRecoveryMoves(
    live.map((fact) => ({
      name: fact.name,
      installedSkill: imported.installed_skills.find(
        (item) => item.installed_skill_id === fact.installedSkillId,
      )!,
    })),
    operationDirectory,
  );
  // Retention/rendering must not silently renew filesystem consent.
  for (const fact of live)
    if (hashParts([canonicalJson(yield* captureSetupFile(resolve(fact.path)))]) !== fact.evidence)
      return yield* new PlanIsStale();
  yield* backup.apply();
  for (const fact of live) {
    const installedSkill = imported.installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
    )!;
    yield* installEnabledSkills({
      target: fact.destination,
      scope: { kind: "global" },
      root: installedSkill.root,
      variantsPath: store.variantsPath,
      onlySkillIds: [fact.skillId],
      restoreNativeDeletedSkills: [fact.skillId],
    });
    const after = (yield* store.load).installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
    );
    if (
      !after ||
      after.status !== "installed" ||
      after.expected_digest !== desired.get(fact.installedSkillId) ||
      (yield* deterministicTreeHash(fact.path)) !== desired.get(fact.installedSkillId)
    )
      return yield* new PlanIsStale();
  }
  return {
    recoveryDirectory: backup.recoveryDirectory,
    outcomes: facts
      .filter((fact) => selected.has(fact.skillId))
      .map((fact) => ({
        installedSkillId: fact.installedSkillId,
        name: fact.name,
        path: fact.path,
        status: fact.status === "native-delete" ? ("native-delete" as const) : ("updated" as const),
      })),
  };
});
