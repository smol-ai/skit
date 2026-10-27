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
  retainChangedInstalledSkill,
  scopeBinding,
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
    const projection = state.projections.find((item) => item.projection_id === fact.projectionId);
    const skill = state.skills.find((item) => item.skill_id === fact.skillId);
    if (
      !projection ||
      !skill ||
      projection.path !== fact.path ||
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
      retainChangedInstalledSkill({
        skillId: copy.skillId,
        projectionId: copy.projectionId,
        path: copy.path,
        observedHash: copy.currentHash,
        retainedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      }),
    );
  }
  const retained = yield* store.load;
  // Render all selected destinations before displacing any of them. This also uses their policy.
  const desired = new Map<string, string>();
  for (const fact of live) {
    const projection = retained.projections.find(
      (item) => item.projection_id === fact.projectionId,
    )!;
    const skill = retained.skills.find((item) => item.skill_id === fact.skillId)!;
    const version = currentSkillVersion(retained, skill)!;
    const policy = scopeBinding(retained, { kind: "global" })?.invocation_policies?.[fact.skillId];
    const digest = yield* Effect.scoped(
      Effect.gen(function* () {
        const renderer = yield* prepareInstalledSkillRebuild(
          retained,
          store.originalsPath,
          { ...projection, skill_version_id: version.skill_version_id },
          policy === undefined ? { source: "declared" } : { source: "override", policy },
        );
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-choice-" });
        const path = join(directory, "skill");
        yield* renderer.build(path);
        return yield* deterministicTreeHash(path);
      }),
    );
    desired.set(fact.projectionId, digest);
  }
  const preservation = yield* prepareOwnedRecoveryMoves(
    live.map((fact) => ({
      name: fact.name,
      projection: retained.projections.find((item) => item.projection_id === fact.projectionId)!,
    })),
    operationDirectory,
  );
  // Retention/rendering must not silently renew filesystem consent.
  for (const fact of live)
    if (hashParts([canonicalJson(yield* captureSetupFile(resolve(fact.path)))]) !== fact.evidence)
      return yield* new PlanIsStale();
  yield* preservation.apply();
  for (const fact of live) {
    const projection = retained.projections.find(
      (item) => item.projection_id === fact.projectionId,
    )!;
    yield* installEnabledSkills({
      target: fact.target,
      scope: { kind: "global" },
      root: projection.root,
      variantsPath: store.variantsPath,
      onlySkillIds: [fact.skillId],
      restoreNativeDeletedSkills: [fact.skillId],
    });
    const after = (yield* store.load).projections.find(
      (item) => item.projection_id === fact.projectionId,
    );
    if (
      !after ||
      after.status !== "installed" ||
      after.expected_digest !== desired.get(fact.projectionId) ||
      (yield* deterministicTreeHash(fact.path)) !== desired.get(fact.projectionId)
    )
      return yield* new PlanIsStale();
  }
  return {
    recoveryDirectory: preservation.recoveryDirectory,
    outcomes: facts
      .filter((fact) => selected.has(fact.skillId))
      .map((fact) => ({
        projectionId: fact.projectionId,
        name: fact.name,
        path: fact.path,
        status: fact.status === "native-delete" ? ("native-delete" as const) : ("updated" as const),
      })),
  };
});
