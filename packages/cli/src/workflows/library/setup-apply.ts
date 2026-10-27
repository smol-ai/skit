import { join } from "node:path";
import { Effect } from "effect";
import {
  LibraryChanged,
  currentSkillVersion,
  canonicalJson,
  LibraryStore,
  ensureProjectionRootWritable,
  libraryStateRevision,
  withLibraryWriter,
  type Digest,
  type SkillId,
} from "@smolai/skit-core";
import { activeProjectionTargetsEffect, bindingRoot } from "../../projection/roots.js";
import type { LocalAdoptionOptions } from "./local-adoption.js";
import { revalidateSetupPlan, saveSetupMachineConfig, type SetupOptions } from "./setup.js";
import type {
  SetupKnownSourceSelection,
  SetupReconciliationFact,
  SetupVersionChoice,
  SetupReconciliationOutcome,
} from "./setup-contract.js";
import { isSetupProjectionTarget, type SetupCopySelection } from "./setup-decisions.js";
import { applySetupExistingBindings } from "./setup-existing-binding.js";
import { applySetupLocalCustody } from "./setup-local-custody.js";
import { applySetupObservedCollections } from "./setup-observed-collections.js";
import { beginSetupOperation } from "../../library-application/setup-operation.js";
import type { PreparedRecoveryMoves } from "../../library-application/recovery-moves.js";
import {
  applyRoutineSetupReconciliation,
  setupReconciliationChanges,
  SetupReconciliationRequired,
  unresolvedSetupReconciliation,
} from "./setup-reconciliation.js";
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
  readonly custody: readonly SetupCopySelection[];
  readonly removals: PreparedRecoveryMoves;
  readonly versionChoices?: readonly SetupVersionChoice[];
  readonly reconciliation?: readonly SetupReconciliationFact[];
}

export interface SetupApplyOptions {
  readonly adoption: LocalAdoptionOptions;
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
    const scan = yield* options.withStatus(
      "Revalidating the approved setup plan",
      revalidateSetupPlan(approval.setup, approval.planId),
    );
    const reconciliation = approval.reconciliation ?? scan.observed.reconciliation ?? [];
    const reviewedIds = new Set<string>();
    for (const fact of reconciliation) {
      if (
        reviewedIds.has(fact.projectionId) ||
        canonicalJson(fact) !==
          canonicalJson(
            scan.observed.reconciliation?.find((item) => item.projectionId === fact.projectionId) ??
              null,
          )
      )
        return yield* new PlanIsStale();
      reviewedIds.add(fact.projectionId);
    }
    const reviewedSkills = new Set(reconciliation.map((fact) => fact.skillId));
    if (
      (scan.observed.reconciliation ?? []).some(
        (fact) => reviewedSkills.has(fact.skillId) && !reviewedIds.has(fact.projectionId),
      )
    )
      return yield* new PlanIsStale();
    const versionChoices = approval.versionChoices ?? [];
    const alternatives = setupVersionAlternatives(reconciliation);
    if (
      new Set(versionChoices.map((choice) => choice.skillId)).size !== versionChoices.length ||
      versionChoices.some(
        (choice) =>
          !alternatives.some((alternative) => canonicalJson(choice) === canonicalJson(alternative)),
      )
    )
      return yield* new PlanIsStale();
    const unresolved = unresolvedSetupReconciliation(reconciliation, versionChoices);
    if (unresolved.length) return yield* new SetupReconciliationRequired({ facts: unresolved });
    // Only enabled global copies project into this device's roots. Prove those roots
    // are writable before any stage writes, so a sandboxed or read-only root (Codex keeps `.agents`
    // read-only) fails the apply whole instead of leaving a Library with no copies behind.
    const projectedCopies = [...approval.bindings, ...approval.custody].filter(
      (copy) =>
        copy.duplicateAction !== "retain-only" &&
        isSetupProjectionTarget(
          scan.observed.instances.find((instance) => instance.path === copy.sourcePath),
        ) &&
        !scan.observed.onboarding.candidates.some(
          (candidate) =>
            candidate.action === "repository-owned" && candidate.paths.includes(copy.sourcePath),
        ),
    );
    const enablingCopies = projectedCopies.length > 0;
    const projects = enablingCopies || setupReconciliationChanges(reconciliation, versionChoices);
    if (projects)
      for (const target of yield* activeProjectionTargetsEffect(approval.setup.inventory))
        if (
          enablingCopies ||
          reconciliation.some(
            (fact) =>
              fact.target === target &&
              (fact.status === "incoming-update" ||
                fact.metadataChanged ||
                (fact.status !== "native-delete" &&
                  versionChoices.some((choice) => choice.skillId === fact.skillId))),
          )
        )
          yield* ensureProjectionRootWritable(
            bindingRoot(target, { kind: "global" }, approval.setup.inventory),
          );
    let current = scan.observed;
    const store = yield* LibraryStore;
    let revision = libraryStateRevision(scan.library);
    const operation = yield* beginSetupOperation(
      { ...approval, reconciliation },
      scan.library,
      projects,
      projectedCopies.map((copy) => copy.name),
    );
    const warnings: { name: string; message: string }[] = [];
    const recoveryDirectories: string[] = [];
    const reconciliationOutcomes: SetupReconciliationOutcome[] = [];
    const adoption = {
      ...options.adoption,
      recoveryOperationDirectory: approval.removals.operationDirectory,
    };
    yield* Effect.gen(function* () {
      if (
        approval.persistRoots ||
        ((approval.imports.length || approval.custody.length) && !current.machineConfig.machineId)
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
        yield* operation.settingsPublished();
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
          applySetupObservedCollections({ setup: approval.setup }, current, approval.imports),
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
          applySetupExistingBindings(adoption, current, approval.bindings),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
      if (approval.custody.length) {
        const names =
          approval.custody.length <= 5
            ? `: ${approval.custody.map((selection) => selection.name).join(", ")}`
            : "";
        const applied = yield* options.withStatus(
          `Taking custody of ${approval.custody.length} local Skill${approval.custody.length === 1 ? "" : "s"}${names}`,
          applySetupLocalCustody(adoption, current, approval.custody),
        );
        warnings.push(...applied.warnings);
        recoveryDirectories.push(...applied.recoveryDirectories);
      }
      const deferredSkills = new Set<SkillId>();
      if (approval.imports.length) {
        const imported = yield* store.load;
        if (libraryStateRevision(imported) !== revision)
          return yield* new LibraryChanged({ path: join(store.home, "state.json") });
        for (const fact of scan.observed.reconciliation ?? []) {
          const skill = imported.skills.find((item) => item.skill_id === fact.skillId);
          if (
            skill &&
            currentSkillVersion(imported, skill)?.skill_version_id !== fact.desiredVersionId
          )
            deferredSkills.add(fact.skillId);
        }
      }
      for (const fact of scan.observed.reconciliation ?? []) {
        if (!deferredSkills.has(fact.skillId)) continue;
        reconciliationOutcomes.push({
          projectionId: fact.projectionId,
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
            reconciliation,
            currentChoices,
            approval.removals.operationDirectory,
          ),
        );
        reconciliationOutcomes.push(...chosen.outcomes);
        recoveryDirectories.push(chosen.recoveryDirectory);
      }
      if (reconciliation.length)
        reconciliationOutcomes.push(
          ...(yield* options.withStatus(
            "Reconciling reviewed existing copies",
            applyRoutineSetupReconciliation(
              reconciliation.filter(
                (fact) => !chosenSkills.has(fact.skillId) && !deferredSkills.has(fact.skillId),
              ),
            ),
          )),
        );
    }).pipe(
      Effect.provideService(LibraryStore, {
        ...store,
        publish: (next, base) =>
          libraryStateRevision(base) === revision
            ? Effect.tap(operation.publish(next, base), () =>
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
      observed: current,
      warnings,
      recoveryDirectories,
      reconciliation: reconciliationOutcomes,
      operationId: operation.operationId,
    };
  },
  (effect) => withLibraryWriter(effect),
);
