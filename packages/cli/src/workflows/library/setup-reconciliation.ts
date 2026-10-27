import { basename, join, resolve } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import {
  bindingSkillIds,
  canonicalJson,
  currentSkillVersion,
  deterministicTreeHash,
  hashParts,
  inspectOwnershipMarker,
  LibraryStore,
  prepareInstalledSkillRebuild,
  installedSkillDisplaced,
  repositorySelectsInstalledSkill,
  scopeBinding,
  projectBinding,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
} from "@smolai/skit-core";
import { captureSetupFile } from "../../library-application/setup-operation.js";
import {
  activeInstallDestinationsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import type {
  SetupReconciliationFact,
  SetupSkillInstance,
  SetupVersionChoice,
  SetupReconciliationOutcome,
} from "./setup-contract.js";
import { checkSetupGlobalContent } from "../../library-application/setup-content-custody.js";
import { PlanIsStale } from "../../library/failures.js";

export class SetupReconciliationRequired
  extends Data.TaggedError("SetupReconciliationRequired")<{
    readonly facts: readonly SetupReconciliationFact[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return this.facts
      .map(
        (fact) =>
          `${fact.name} at ${fact.path}: ${fact.status === "competing" ? `current ${fact.currentHash} and retained ${fact.desiredHash} need a version choice` : (fact.reason ?? "custody needs resolution")}`,
      )
      .join("; ");
  }
  readonly remediation =
    "Review setup's current copy and retained-version facts before applying these unresolved changes.";
}

export const unresolvedSetupReconciliation = (
  facts: readonly SetupReconciliationFact[],
  choices: readonly SetupVersionChoice[] = [],
) =>
  facts.filter(
    (fact) =>
      fact.status === "protected" ||
      (fact.status === "competing" && !choices.some((choice) => choice.skillId === fact.skillId)),
  );
export const setupReconciliationChanges = (
  facts: readonly SetupReconciliationFact[],
  choices: readonly SetupVersionChoice[] = [],
) =>
  choices.length > 0 ||
  facts.some((fact) => fact.status === "incoming-update" || fact.metadataChanged);
export const setupReconciliationOutcomes = (
  facts: readonly SetupReconciliationFact[],
  applied: boolean,
): SetupReconciliationOutcome[] =>
  facts.map((fact) => ({
    projectionId: fact.projectionId,
    name: fact.name,
    path: fact.path,
    status:
      fact.status === "local-only"
        ? ("local-kept" as const)
        : fact.status === "native-delete"
          ? ("native-delete" as const)
          : fact.status === "incoming-update" || fact.metadataChanged
            ? applied
              ? ("updated" as const)
              : ("pending" as const)
            : ("unchanged" as const),
  }));

/** Compare the same byte owner used for writes with corroborated last-written custody. */
export const checkSetupReconciliation = Effect.fn("Setup.checkReconciliation")(function* (
  state: LibraryState,
  roots: InventoryRootOptions,
  instances: readonly SetupSkillInstance[],
) {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* LibraryStore;
  const binding = scopeBinding(state, { kind: "global" });
  if (!binding) return [];
  const selected = new Set(bindingSkillIds(state, binding));
  const targets = yield* activeInstallDestinationsEffect(roots);
  const facts: SetupReconciliationFact[] = [];
  for (const projection of state.projections) {
    const target = projection.target;
    if (
      target === "legacy" ||
      !selected.has(projection.skill_id) ||
      repositorySelectsInstalledSkill(state, projection)
    )
      continue;
    const skill = state.skills.find((item) => item.skill_id === projection.skill_id);
    if (!skill) continue;
    const version = currentSkillVersion(state, skill);
    const base = {
      projectionId: projection.projection_id,
      skillId: skill.skill_id,
      name: skill.name,
      path: projection.path,
      target,
      baselineHash: projection.expected_digest,
      ...(version ? { desiredVersionId: version.skill_version_id } : {}),
      metadataChanged: false,
    };
    const observed = yield* Effect.result(captureSetupFile(resolve(projection.path)));
    if (observed._tag === "Failure") {
      facts.push({
        ...base,
        status: "protected",
        reason: "Current copy could not be fully observed",
        evidence: hashParts([projection.path, "unreadable"]),
      });
      continue;
    }
    const before = observed.success;
    const evidence = hashParts([canonicalJson(before)]);
    const protect = (reason: string): SetupReconciliationFact => ({
      ...base,
      evidence,
      status: "protected",
      reason,
    });
    if (
      !targets.includes(target) ||
      resolve(projection.path) !==
        join(resolve(bindingRoot(target, { kind: "global" }, roots)), skill.name)
    ) {
      facts.push(protect("The recorded copy is outside the active global route"));
      continue;
    }
    if (before.entry === null) {
      const displaced = yield* installedSkillDisplaced(projection);
      facts.push(
        displaced
          ? protect("An unsettled backup explains the missing copy")
          : {
              ...base,
              evidence,
              status: "native-delete",
              reason: "Native deletion is preserved",
            },
      );
      continue;
    }
    if (before.entry.type !== "Directory" || before.entry.markerType !== "File") {
      facts.push(
        protect("The copy or its custody marker is no longer an independent regular entry"),
      );
      continue;
    }
    const physical = join(before.anchor.physicalPath, basename(projection.path));
    const instance = instances.find(
      (item) =>
        item.path === projection.path ||
        item.path === physical ||
        item.aliases.includes(projection.path),
    );
    if (
      !instance ||
      instance.scope !== "global" ||
      instance.git.repository ||
      instance.owner.kind !== "skit" ||
      instance.owner.membership.kind !== "retained" ||
      instance.owner.membership.projectionId !== projection.projection_id
    ) {
      facts.push(protect("Global reader scope and Library custody are not fully corroborated"));
      continue;
    }
    if ((yield* Effect.result(checkSetupGlobalContent(projection.path)))._tag === "Failure") {
      facts.push(
        protect(
          "Repository, authored or package-manager protection prevents automatic reconciliation",
        ),
      );
      continue;
    }
    const marker = yield* inspectOwnershipMarker(projection.path);
    if (
      marker.kind !== "valid" ||
      marker.marker.projection_id !== projection.projection_id ||
      marker.marker.skill_id !== projection.skill_id ||
      marker.marker.skill_version_id !== projection.skill_version_id ||
      marker.marker.expected_digest !== projection.expected_digest ||
      !version
    ) {
      facts.push(protect("The marker disagrees with the registered last-written baseline"));
      continue;
    }
    const policy = binding.invocation_policies?.[skill.skill_id];
    const desired = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const renderer = yield* prepareInstalledSkillRebuild(
            state,
            store.originalsPath,
            { ...projection, skill_version_id: version.skill_version_id },
            policy === undefined ? { source: "declared" } : { source: "override", policy },
          );
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "skit-setup-desired-" });
          const path = join(directory, "skill");
          yield* renderer.build(path);
          return yield* deterministicTreeHash(path);
        }),
      ),
    );
    if (desired._tag === "Failure") {
      facts.push(protect("The selected retained version could not be rendered"));
      continue;
    }
    const current = yield* deterministicTreeHash(projection.path);
    const after = yield* captureSetupFile(resolve(projection.path));
    if (canonicalJson(before) !== canonicalJson(after)) {
      facts.push(protect("The copy changed during observation"));
      continue;
    }
    const status =
      current === desired.success
        ? "unchanged"
        : current === projection.expected_digest
          ? "incoming-update"
          : desired.success === projection.expected_digest
            ? "local-only"
            : "competing";
    facts.push({
      ...base,
      evidence,
      status,
      currentHash: current,
      desiredHash: desired.success,
      metadataChanged:
        status === "unchanged" &&
        (projection.skill_version_id !== version.skill_version_id ||
          projection.expected_digest !== desired.success ||
          projection.status !== "installed"),
    });
  }
  return facts.sort((left, right) => left.path.localeCompare(right.path));
});

/** The caller owns setup's writer and inverse evidence; this owner limits native work to reviewed coordinates. */
export const applyRoutineSetupReconciliation = Effect.fn("Setup.applyRoutineReconciliation")(
  function* (facts: readonly SetupReconciliationFact[]) {
    const unresolved = unresolvedSetupReconciliation(facts);
    if (unresolved.length) return yield* new SetupReconciliationRequired({ facts: unresolved });
    const store = yield* LibraryStore;
    for (const fact of facts) {
      if (fact.status === "native-delete") continue;
      const state = yield* store.load;
      const projection = state.projections.find((item) => item.projection_id === fact.projectionId);
      const skill = state.skills.find((item) => item.skill_id === fact.skillId);
      const binding = scopeBinding(state, { kind: "global" });
      if (
        !projection ||
        !skill ||
        !binding ||
        !bindingSkillIds(state, binding).includes(fact.skillId) ||
        currentSkillVersion(state, skill)?.skill_version_id !== fact.desiredVersionId ||
        projection.path !== fact.path ||
        projection.target !== fact.target
      )
        return yield* new PlanIsStale();
      if (fact.status !== "incoming-update" && !fact.metadataChanged) continue;
      yield* checkSetupGlobalContent(fact.path);
      const current = yield* deterministicTreeHash(fact.path);
      const marker = yield* inspectOwnershipMarker(fact.path);
      if (
        marker.kind !== "valid" ||
        marker.marker.projection_id !== projection.projection_id ||
        marker.marker.skill_id !== projection.skill_id ||
        marker.marker.skill_version_id !== projection.skill_version_id ||
        marker.marker.expected_digest !== projection.expected_digest
      )
        return yield* new PlanIsStale();
      // Another approved additive setup stage may already have aligned this exact copy.
      if (
        current === fact.desiredHash &&
        projection.skill_version_id === fact.desiredVersionId &&
        projection.expected_digest === fact.desiredHash &&
        projection.status === "installed"
      )
        continue;
      const evidence = hashParts([canonicalJson(yield* captureSetupFile(resolve(fact.path)))]);
      if (evidence !== fact.evidence || current !== fact.currentHash)
        return yield* new PlanIsStale();
      yield* projectBinding({
        target: fact.target,
        scope: { kind: "global" },
        root: projection.root,
        variantsPath: store.variantsPath,
        onlySkillIds: [fact.skillId],
        ...(current === fact.desiredHash
          ? {
              acceptedObservations: new Map([
                [fact.projectionId, { observedHash: current, marker: marker.marker }],
              ]),
            }
          : {}),
      });
      const after = (yield* store.load).projections.find(
        (item) => item.projection_id === fact.projectionId,
      );
      if (
        !after ||
        after.status !== "installed" ||
        after.expected_digest !== fact.desiredHash ||
        after.skill_version_id !== fact.desiredVersionId ||
        (yield* deterministicTreeHash(fact.path)) !== fact.desiredHash
      )
        return yield* new PlanIsStale();
    }
    return setupReconciliationOutcomes(facts, true);
  },
);
