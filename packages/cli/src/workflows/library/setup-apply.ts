import { join } from "node:path";
import { Effect } from "effect";
import {
  LibraryChanged,
  currentSkillVersion,
  canonicalJson,
  LibraryStore,
  ensureSkillsDirectoryWritable,
  libraryStateRevision,
  withLibraryWriter,
  type Digest,
  type SkillId,
} from "@smolai/skit-core";
import { activeInstallDestinations, skillsDirectoryFor } from "../../install/roots.js";
import type { ManageOptions } from "./manage-existing.js";
import { revalidateSetupPlan, saveSetupMachineConfig, type SetupOptions } from "./setup.js";
import type {
  SetupKnownSourceSelection,
  InstalledSkillChange,
  SetupVersionChoice,
  InstalledSkillChangeResult,
} from "./setup-contract.js";
import { isSetupInstallDestination, type SetupCopySelection } from "./setup-decisions.js";
import { manageSetupCopies } from "./setup-manage.js";
import { importSetupCollections } from "./setup-import.js";
import { beginSetupOperation } from "../../library-application/setup-operation.js";
import type { PreparedRecoveryMoves } from "../../library-application/recovery-moves.js";
import {
  installSelectedVersions,
  hasChangesToApply,
  ChangeChoiceRequired,
  changesNeedingChoice,
} from "./installed-skill-changes.js";
import { applyChosenSetupVersions, setupVersionAlternatives } from "./setup-version-choice.js";
import { PlanIsStale } from "../../library/failures.js";

/** What the user reviewed and approved: the plan ID they saw and the selections they made. */
export interface SetupApproval {
  readonly setup: SetupOptions;
  readonly planId: Digest;
  /** Save the discovery roots and repository decisions this setup observes. */
  readonly persistRoots: boolean;
  readonly imports: readonly SetupKnownSourceSelection[];
  readonly bindings: readonly SetupCopySelection[];
  readonly ownership: readonly SetupCopySelection[];
  readonly removals: PreparedRecoveryMoves;
  readonly versionChoices?: readonly SetupVersionChoice[];
  readonly changes?: readonly InstalledSkillChange[];
}

export interface SetupApplyOptions {
  readonly manage: ManageOptions;
  /** Runs each stage under its progress message. */
  readonly withStatus: <A, E, R>(
    message: string,
    stage: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Apply an approved setup plan from one scan taken under the Library writer.
 *
 * That scan must reproduce the approved plan ID, which covers the observed copies and the Library
 * revision. No stage observes again, so consent never moves to a plan the user did not review;
 * each stage still checks the identity of what it touches immediately before touching it. Every
 * Library publication must build on the approved revision or on this apply's previous publication.
 * Additive stages run first and removals last, so a failed or stale additive stage removes nothing.
 */
export const applySetupPlan = Effect.fn("Setup.applyPlan")(
  function* (options: SetupApplyOptions, approval: SetupApproval) {
    const revalidated = yield* options.withStatus(
      "Revalidating the approved setup plan",
      revalidateSetupPlan(approval.setup, approval.planId),
    );
    const installedSkillChanges = approval.changes ?? revalidated.scan.changes ?? [];
    const reviewedIds = new Set<string>();
    for (const fact of installedSkillChanges) {
      if (
        reviewedIds.has(fact.installedSkillId) ||
        canonicalJson(fact) !==
          canonicalJson(
            revalidated.scan.changes?.find(
              (item) => item.installedSkillId === fact.installedSkillId,
            ) ?? null,
          )
      )
        return yield* new PlanIsStale();
      reviewedIds.add(fact.installedSkillId);
    }
    const reviewedSkills = new Set(installedSkillChanges.map((fact) => fact.skillId));
    if (
      (revalidated.scan.changes ?? []).some(
        (fact) => reviewedSkills.has(fact.skillId) && !reviewedIds.has(fact.installedSkillId),
      )
    )
      return yield* new PlanIsStale();
    const versionChoices = approval.versionChoices ?? [];
    const alternatives = setupVersionAlternatives(installedSkillChanges);
    if (
      new Set(versionChoices.map((choice) => choice.skillId)).size !== versionChoices.length ||
      versionChoices.some(
        (choice) =>
          !alternatives.some((alternative) => canonicalJson(choice) === canonicalJson(alternative)),
      )
    )
      return yield* new PlanIsStale();
    const unresolved = changesNeedingChoice(installedSkillChanges, versionChoices);
    if (unresolved.length) return yield* new ChangeChoiceRequired({ facts: unresolved });
    // Only enabled global copies install into this device's skills directories. Prove those roots
    // are writable before any stage writes, so a sandboxed or read-only root (Codex keeps `.agents`
    // read-only) fails the apply whole instead of leaving a Library with no copies behind.
    const installedCopies = [...approval.bindings, ...approval.ownership].filter(
      (copy) =>
        copy.duplicateAction !== "retain-only" &&
        isSetupInstallDestination(
          revalidated.scan.instances.find((instance) => instance.path === copy.sourcePath),
        ) &&
        !revalidated.scan.onboarding.candidates.some(
          (candidate) =>
            candidate.action === "repository-owned" && candidate.paths.includes(copy.sourcePath),
        ),
    );
    const enablingCopies = installedCopies.length > 0;
    const projects = enablingCopies || hasChangesToApply(installedSkillChanges, versionChoices);
    if (projects)
      for (const target of yield* activeInstallDestinations(approval.setup.inventory))
        if (
          enablingCopies ||
          installedSkillChanges.some(
            (fact) =>
              fact.destination === target &&
              (fact.status === "incoming-update" ||
                fact.metadataChanged ||
                (fact.status !== "native-delete" &&
                  versionChoices.some((choice) => choice.skillId === fact.skillId))),
          )
        )
          yield* ensureSkillsDirectoryWritable(
            skillsDirectoryFor(target, { kind: "global" }, approval.setup.inventory),
          );
    let current = revalidated.scan;
    const store = yield* LibraryStore;
    let revision = libraryStateRevision(revalidated.library);
    const operation = yield* beginSetupOperation(
      { ...approval, changes: installedSkillChanges },
      revalidated.library,
      projects,
      installedCopies.map((copy) => copy.name),
    );
    const warnings: { name: string; message: string }[] = [];
    const recoveryDirectories: string[] = [];
    const changeOutcomes: InstalledSkillChangeResult[] = [];
    const manage = {
      ...options.manage,
      recoveryOperationDirectory: approval.removals.operationDirectory,
    };
    yield* Effect.gen(function* () {
      if (
        approval.persistRoots ||
        ((approval.imports.length || approval.ownership.length) && !current.machineConfig.machineId)
      ) {
        const saved = yield* options.withStatus(
          current.machineConfig.machineId
            ? "Saving this machine's discovery roots"
            : "Creating this machine's Library identity",
          saveSetupMachineConfig(
            { ...approval.setup, persistRoots: true },
            operation.recordSettings,
          ),
        );
        yield* operation.settingsSaved();
        current = {
          ...current,
          machineConfig: {
            ...current.machineConfig,
            ...(saved.machineId === undefined ? {} : { machineId: saved.machineId }),
            ...(saved.displayName === undefined ? {} : { displayName: saved.displayName }),
            persisted: approval.persistRoots,
          },
        };
      }
      if (approval.imports.length) {
        const collections = new Set(approval.imports.map((selection) => selection.groupKey)).size;
        yield* options.withStatus(
          `Importing ${collections} installed Collection${collections === 1 ? "" : "s"} (${approval.imports.length} Skill${approval.imports.length === 1 ? "" : "s"})`,
          importSetupCollections({ setup: approval.setup }, current, approval.imports),
        );
      }
      if (approval.bindings.length) {
        const reconnects = approval.bindings.filter(
          (selection) => selection.duplicateAction !== "retain-only",
        ).length;
        const applied = yield* options.withStatus(
          reconnects
            ? `Reconnecting ${reconnects} existing Library match${reconnects === 1 ? "" : "es"}`
            : "Keeping existing Library matches without enabling",
          manageSetupCopies(manage, current, approval.bindings, "existing"),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
      if (approval.ownership.length) {
        const names =
          approval.ownership.length <= 5
            ? `: ${approval.ownership.map((selection) => selection.name).join(", ")}`
            : "";
        const applied = yield* options.withStatus(
          `Managing ${approval.ownership.length} existing local Skill${approval.ownership.length === 1 ? "" : "s"}${names}`,
          manageSetupCopies(manage, current, approval.ownership, "new"),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
      const deferredSkills = new Set<SkillId>();
      if (approval.imports.length) {
        const imported = yield* store.load;
        if (libraryStateRevision(imported) !== revision)
          return yield* new LibraryChanged({ path: join(store.home, "state.json") });
        for (const fact of revalidated.scan.changes ?? []) {
          const skill = imported.skills.find((item) => item.skill_id === fact.skillId);
          if (
            skill &&
            currentSkillVersion(imported, skill)?.skill_version_id !== fact.desiredVersionId
          )
            deferredSkills.add(fact.skillId);
        }
      }
      for (const fact of revalidated.scan.changes ?? []) {
        if (!deferredSkills.has(fact.skillId)) continue;
        changeOutcomes.push({
          installedSkillId: fact.installedSkillId,
          name: fact.name,
          path: fact.path,
          status: fact.status === "native-delete" ? "native-delete" : "pending",
          reason:
            "The source import changed the desired Version. Observe setup and review these copies again; this apply leaves them untouched.",
        });
      }
      const currentChoices = versionChoices.filter((choice) => !deferredSkills.has(choice.skillId));
      const chosenSkills = new Set(currentChoices.map((choice) => choice.skillId));
      if (currentChoices.length) {
        const chosen = yield* options.withStatus(
          "Applying the selected active versions",
          applyChosenSetupVersions(
            installedSkillChanges,
            currentChoices,
            approval.removals.operationDirectory,
          ),
        );
        changeOutcomes.push(...chosen.outcomes);
        recoveryDirectories.push(chosen.recoveryDirectory);
      }
      if (installedSkillChanges.length)
        changeOutcomes.push(
          ...(yield* options.withStatus(
            "Reconciling reviewed existing copies",
            installSelectedVersions(
              installedSkillChanges.filter(
                (fact) => !chosenSkills.has(fact.skillId) && !deferredSkills.has(fact.skillId),
              ),
            ),
          )),
        );
    }).pipe(
      Effect.provideService(LibraryStore, {
        ...store,
        save: (next, base) =>
          libraryStateRevision(base) === revision
            ? Effect.tap(operation.save(next, base), () =>
                Effect.sync(() => {
                  revision = libraryStateRevision(next);
                }),
              )
            : Effect.fail(new LibraryChanged({ path: join(store.home, "state.json") })),
      }),
    );
    if (approval.removals.entries.length) {
      if (libraryStateRevision(yield* store.load) !== revision)
        return yield* new LibraryChanged({ path: join(store.home, "state.json") });
      yield* options.withStatus(
        `Removing ${approval.removals.entries.length} installed cop${approval.removals.entries.length === 1 ? "y" : "ies"}`,
        approval.removals.apply(),
      );
    }
    yield* operation.complete();
    return {
      scan: current,
      warnings,
      recoveryDirectories,
      changes: changeOutcomes,
      operationId: operation.operationId,
    };
  },
  (effect) => withLibraryWriter(effect),
);
