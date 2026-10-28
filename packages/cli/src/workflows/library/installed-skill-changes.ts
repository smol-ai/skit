import { basename, join, resolve } from "node:path";
import { Data, Effect, FileSystem } from "effect";
import {
  enabledSkillIds,
  canonicalJson,
  currentSkillVersion,
  deterministicTreeHash,
  hashParts,
  inspectOwnershipMarker,
  LibraryStore,
  prepareInstalledSkillRebuild,
  installedSkillDisplaced,
  repositorySelectsInstalledSkill,
  globalEnabled,
  installEnabledSkills,
  FailureTypeId,
  type SkitFailure,
  type LibraryState,
} from "@smolai/skit-core";
import { captureSetupFile } from "../../library-application/setup-operation.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../../install/roots.js";
import type {
  InstalledSkillChange,
  SetupSkillInstance,
  SetupVersionChoice,
  InstalledSkillChangeResult,
} from "./setup-contract.js";
import { checkSetupGlobalContent } from "../../library-application/setup-external-ownership.js";
import { PlanIsStale } from "../../library/failures.js";

export class ChangeChoiceRequired
  extends Data.TaggedError("ChangeChoiceRequired")<{
    readonly facts: readonly InstalledSkillChange[];
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

export const changesNeedingChoice = (
  facts: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[] = [],
) =>
  facts.filter(
    (fact) =>
      fact.status === "protected" ||
      (fact.status === "competing" && !choices.some((choice) => choice.skillId === fact.skillId)),
  );
export const hasChangesToApply = (
  facts: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[] = [],
) =>
  choices.length > 0 ||
  facts.some((fact) => fact.status === "incoming-update" || fact.metadataChanged);
export const changeResults = (
  facts: readonly InstalledSkillChange[],
  applied: boolean,
): InstalledSkillChangeResult[] =>
  facts.map((fact) => ({
    installedSkillId: fact.installedSkillId,
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

/** Compare the same byte owner used for writes with corroborated last-written ownership. */
export const findInstalledSkillChanges = Effect.fn("Setup.findInstalledSkillChanges")(function* (
  state: LibraryState,
  roots: InventoryRootOptions,
  instances: readonly SetupSkillInstance[],
) {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* LibraryStore;
  const selected = new Set(enabledSkillIds(state, globalEnabled(state).enabled));
  if (selected.size === 0) return [];
  const targets = yield* activeInstallDestinations(roots);
  const facts: InstalledSkillChange[] = [];
  for (const installedSkill of state.installed_skills) {
    const target = installedSkill.destination;
    if (
      target === "legacy" ||
      !selected.has(installedSkill.skill_id) ||
      repositorySelectsInstalledSkill(state, installedSkill)
    )
      continue;
    const skill = state.skills.find((item) => item.skill_id === installedSkill.skill_id);
    if (!skill) continue;
    const version = currentSkillVersion(state, skill);
    const base = {
      installedSkillId: installedSkill.installed_skill_id,
      skillId: skill.skill_id,
      name: skill.name,
      path: installedSkill.path,
      destination: target,
      baselineHash: installedSkill.expected_digest,
      ...(version ? { desiredVersionId: version.skill_version_id } : {}),
      metadataChanged: false,
    };
    const observed = yield* Effect.result(captureSetupFile(resolve(installedSkill.path)));
    if (observed._tag === "Failure") {
      facts.push({
        ...base,
        status: "protected",
        reason: "Current copy could not be fully observed",
        evidence: hashParts([installedSkill.path, "unreadable"]),
      });
      continue;
    }
    const before = observed.success;
    const evidence = hashParts([canonicalJson(before)]);
    const protect = (reason: string): InstalledSkillChange => ({
      ...base,
      evidence,
      status: "protected",
      reason,
    });
    if (
      !targets.includes(target) ||
      resolve(installedSkill.path) !==
        join(resolve(skillsDirectoryFor(target, { kind: "global" }, roots)), skill.name)
    ) {
      facts.push(protect("The recorded copy is outside the active global route"));
      continue;
    }
    if (before.entry === null) {
      const displaced = yield* installedSkillDisplaced(installedSkill);
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
        protect("The copy or its ownership marker is no longer an independent regular entry"),
      );
      continue;
    }
    const physical = join(before.anchor.physicalPath, basename(installedSkill.path));
    const instance = instances.find(
      (item) =>
        item.path === installedSkill.path ||
        item.path === physical ||
        item.aliases.includes(installedSkill.path),
    );
    if (
      !instance ||
      instance.scope !== "global" ||
      instance.git.repository ||
      instance.owner.kind !== "skit" ||
      instance.owner.membership.kind !== "in-library" ||
      instance.owner.membership.installedSkillId !== installedSkill.installed_skill_id
    ) {
      facts.push(protect("Global reader scope and Library ownership are not fully corroborated"));
      continue;
    }
    if ((yield* Effect.result(checkSetupGlobalContent(installedSkill.path)))._tag === "Failure") {
      facts.push(
        protect(
          "Repository, authored or package-manager protection prevents automatic reconciliation",
        ),
      );
      continue;
    }
    const marker = yield* inspectOwnershipMarker(installedSkill.path);
    if (
      marker.kind !== "valid" ||
      marker.marker.installed_skill_id !== installedSkill.installed_skill_id ||
      marker.marker.skill_id !== installedSkill.skill_id ||
      marker.marker.skill_version_id !== installedSkill.skill_version_id ||
      marker.marker.expected_digest !== installedSkill.expected_digest ||
      !version
    ) {
      facts.push(protect("The marker disagrees with the registered last-written baseline"));
      continue;
    }
    const policy = globalEnabled(state).invocation_policies?.[skill.skill_id];
    const desired = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const renderer = yield* prepareInstalledSkillRebuild(
            state,
            store.originalsPath,
            { ...installedSkill, skill_version_id: version.skill_version_id },
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
    const current = yield* deterministicTreeHash(installedSkill.path);
    const after = yield* captureSetupFile(resolve(installedSkill.path));
    if (canonicalJson(before) !== canonicalJson(after)) {
      facts.push(protect("The copy changed during observation"));
      continue;
    }
    const status =
      current === desired.success
        ? "unchanged"
        : current === installedSkill.expected_digest
          ? "incoming-update"
          : desired.success === installedSkill.expected_digest
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
        (installedSkill.skill_version_id !== version.skill_version_id ||
          installedSkill.expected_digest !== desired.success ||
          installedSkill.status !== "installed"),
    });
  }
  return facts.sort((left, right) => left.path.localeCompare(right.path));
});

/** The caller owns setup's writer and inverse evidence; this owner limits native work to reviewed coordinates. */
export const installSelectedVersions = Effect.fn("Setup.installSelectedVersions")(function* (
  facts: readonly InstalledSkillChange[],
) {
  const unresolved = changesNeedingChoice(facts);
  if (unresolved.length) return yield* new ChangeChoiceRequired({ facts: unresolved });
  const store = yield* LibraryStore;
  for (const fact of facts) {
    if (fact.status === "native-delete") continue;
    const state = yield* store.load;
    const installedSkill = state.installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
    );
    const skill = state.skills.find((item) => item.skill_id === fact.skillId);
    if (
      !installedSkill ||
      !skill ||
      !enabledSkillIds(state, globalEnabled(state).enabled).includes(fact.skillId) ||
      currentSkillVersion(state, skill)?.skill_version_id !== fact.desiredVersionId ||
      installedSkill.path !== fact.path ||
      installedSkill.destination !== fact.destination
    )
      return yield* new PlanIsStale();
    if (fact.status !== "incoming-update" && !fact.metadataChanged) continue;
    yield* checkSetupGlobalContent(fact.path);
    const current = yield* deterministicTreeHash(fact.path);
    const marker = yield* inspectOwnershipMarker(fact.path);
    if (
      marker.kind !== "valid" ||
      marker.marker.installed_skill_id !== installedSkill.installed_skill_id ||
      marker.marker.skill_id !== installedSkill.skill_id ||
      marker.marker.skill_version_id !== installedSkill.skill_version_id ||
      marker.marker.expected_digest !== installedSkill.expected_digest
    )
      return yield* new PlanIsStale();
    // Another approved additive setup stage may already have aligned this exact copy.
    if (
      current === fact.desiredHash &&
      installedSkill.skill_version_id === fact.desiredVersionId &&
      installedSkill.expected_digest === fact.desiredHash &&
      installedSkill.status === "installed"
    )
      continue;
    const evidence = hashParts([canonicalJson(yield* captureSetupFile(resolve(fact.path)))]);
    if (evidence !== fact.evidence || current !== fact.currentHash) return yield* new PlanIsStale();
    yield* installEnabledSkills({
      target: fact.destination,
      scope: { kind: "global" },
      root: installedSkill.root,
      variantsPath: store.variantsPath,
      onlySkillIds: [fact.skillId],
      ...(current === fact.desiredHash
        ? {
            acceptedObservations: new Map([
              [fact.installedSkillId, { observedHash: current, marker: marker.marker }],
            ]),
          }
        : {}),
    });
    const after = (yield* store.load).installed_skills.find(
      (item) => item.installed_skill_id === fact.installedSkillId,
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
  return changeResults(facts, true);
});
