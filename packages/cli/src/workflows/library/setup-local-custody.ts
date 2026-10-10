import {
  activeProjectionTargetsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import { resolveLibrarySubject } from "./subject-resolution.js";
import { join, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { applySetupRemovals, type SetupRemoval } from "./setup-removal.js";
import {
  observeHarnessShadows,
  readableHarnessRoots,
  type HarnessShadow,
} from "../../projection/harness-shadows.js";
import { Effect, FileSystem, Schema } from "effect";
import {
  LibraryStore,
  LinkStat,
  hasHarnessProfile,
  type HarnessName,
  type Digest,
} from "@smolai/skit-core";
import {
  localAdoptionPlanIdentity,
  planLocalAdoption,
  type LocalAdoptionOptions,
  type LocalAdoptionTarget,
} from "./local-adoption.js";
import { PlanIsStale } from "../../library/failures.js";
import { addLibrarySourceEffect } from "./add.js";
import { applyLibraryBindings, type SetEnabledOptions } from "./set-enabled.js";
import type { SetupResult } from "./setup-contract.js";
import type { ProjectionOptions } from "./projection-options.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";
import { leavePnpmSkillEffect } from "../../projection/pnpm-skills.js";

import {
  copyConflict,
  isSetupProjectionTarget,
  retirableShadowAliases,
  SetupCopySelection,
  SetupApprovedAlias,
} from "./setup-decisions.js";

const SetupLocalCustodySelections = Schema.Array(SetupCopySelection);

export class SetupLocalCustodySelectionInvalid extends Schema.TaggedError<SetupLocalCustodySelectionInvalid>()(
  "SetupLocalCustodySelectionInvalid",
  {
    name: Schema.String,
    reason: Schema.Literals([
      "duplicate-selection",
      "candidate-not-found",
      "candidate-not-manageable",
      "source-not-candidate",
      "machine-identity-required",
      "duplicate-action-required",
      "aliases-not-retirable",
    ]),
  },
) {
  get message() {
    return `Cannot manage ${this.name} locally during setup: ${this.reason}`;
  }
}

export interface SetupLocalCustodyOptions {
  readonly setup: SetupOptions;
  readonly adoption: LocalAdoptionOptions;
}

/** Revalidate setup consent, then apply each explicitly selected local-custody candidate. */
export const applySetupLocalCustody = Effect.fn("Setup.applyLocalCustody")(function* (
  options: SetupLocalCustodyOptions,
  approvedPlanId: Digest,
  selectionInput: readonly SetupCopySelection[],
) {
  const decoded = yield* Schema.decodeUnknownEffect(SetupLocalCustodySelections)(selectionInput);
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  yield* (yield* LibraryStore).load;
  const selections = yield* Effect.forEach(decoded, (selection) =>
    approveSetupCopy(
      current,
      selection,
      (reason) => new SetupLocalCustodySelectionInvalid({ name: selection.name, reason }),
    ),
  );
  const selectedCandidates = new Set<string>();
  const recoveryDirectories: string[] = [];
  const warnings: { name: string; message: string }[] = [];
  for (const selection of selections) {
    const selectionKey = `${selection.name}\0${selection.sourcePath}`;
    if (selectedCandidates.has(selectionKey))
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "duplicate-selection",
      });
    selectedCandidates.add(selectionKey);
    const candidate = current.onboarding.candidates.find(
      (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
    );
    if (!candidate)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "candidate-not-found",
      });
    if (
      candidate.action !== "manage-locally" &&
      candidate.action !== "harness-owned" &&
      candidate.action !== "repository-owned" &&
      candidate.action !== "leave-alone" &&
      !(candidate.action === "blocked" && candidate.reason === "divergent-copies")
    )
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "candidate-not-manageable",
      });
    const sourcePath = selection.sourcePath;
    const selectedInstance = current.instances.find((instance) => instance.path === sourcePath);
    if (
      selection.duplicateAction === "retain-only" ||
      candidate.action === "repository-owned" ||
      !isSetupProjectionTarget(selectedInstance)
    ) {
      const retained = yield* addLibrarySourceEffect(sourcePath);
      if (retained.collection_id === undefined)
        return yield* new SetupLocalCustodySelectionInvalid({
          name: selection.name,
          reason: "source-not-candidate",
        });
      continue;
    }
    const retirement = yield* prepareSetupAliasRetirement(options.setup, selection);
    // An explicit row selects only that physical copy. Differing siblings remain untouched.
    const targets: LocalAdoptionTarget[] = selectedInstance.harnesses.map((harness) => ({
      path: sourcePath,
      harness,
      scope: { kind: "global" },
    }));
    const adoptionPlan = yield* planLocalAdoption(options.adoption, targets, sourcePath);
    if (
      adoptionPlan.targets.some((target) => target.status === "adoptable") &&
      !current.machineConfig.machineId
    )
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "machine-identity-required",
      });
    if (!adoptionPlan.applicable || !adoptionPlan.sourcePath || !adoptionPlan.skill)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-not-candidate",
      });
    const refreshed = yield* planLocalAdoption(
      options.adoption,
      adoptionPlan.targets,
      adoptionPlan.sourcePath,
    );
    if (localAdoptionPlanIdentity(refreshed) !== localAdoptionPlanIdentity(adoptionPlan))
      return yield* new PlanIsStale();
    const retained = yield* addLibrarySourceEffect(adoptionPlan.sourcePath);
    const subjectId = retained.collection_id;
    if (subjectId === undefined)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "source-not-candidate",
      });
    const bound = yield* bindSetupCopy(
      { setup: options.setup, bindings: options.adoption.bindings },
      selection,
      subjectId,
      { path: adoptionPlan.sourcePath, observedHash: adoptionPlan.skill.validationDigest },
      retirement,
    );
    recoveryDirectories.push(...bound.recoveryDirectories);
    warnings.push(...bound.warnings);
  }
  return { planId: current.onboarding.planId, recoveryDirectories, warnings };
});

/** Shared preflight; callers retain their own selection-error contract. */
export const approveSetupCopy = Effect.fn("Setup.approveCopy")(function* <E>(
  current: SetupResult,
  selection: SetupCopySelection,
  invalid: (reason: "duplicate-action-required" | "aliases-not-retirable") => E,
) {
  const conflict = copyConflict(current, selection);
  if (conflict.kind !== "none" && !selection.duplicateAction)
    return yield* Effect.fail(invalid("duplicate-action-required"));
  if (selection.duplicateAction !== "retire-aliases")
    return { ...selection, duplicateAction: selection.duplicateAction };
  if (conflict.kind !== "retirable")
    return yield* Effect.fail(
      selection.approvedAliases ? new PlanIsStale() : invalid("aliases-not-retirable"),
    );
  return {
    ...selection,
    duplicateAction: selection.duplicateAction,
    approvedAliases: yield* captureSetupAliasApproval(
      selection.sourcePath,
      conflict.shadows,
      selection.approvedAliases,
    ),
  };
});

/** Only retirement rows need a fresh shadow scan; prepare before adoption or binding. */
export const prepareSetupAliasRetirement = Effect.fn("Setup.prepareAliasRetirement")(function* (
  setup: SetupOptions,
  selection: Effect.Success<ReturnType<typeof approveSetupCopy>>,
) {
  if (selection.duplicateAction !== "retire-aliases") return undefined;
  const approvedAliases: readonly SetupApprovedAlias[] = selection.approvedAliases;
  const shadows = yield* observeHarnessShadows(setup.inventory, { kind: "global" }, [
    selection.name,
  ]);
  return yield* planSetupAliasRetirement(
    setup.libraryHome,
    selection.name,
    selection.sourcePath,
    shadows,
    approvedAliases,
  );
});

/** Consume a retirement prepared before adoption; bind before retiring any approved link. */
export const bindSetupCopy = Effect.fn("Setup.bindCopy")(function* (
  options: { setup: SetupOptions; bindings: ProjectionOptions },
  selection: SetupCopySelection,
  subjectId: string,
  adoption: NonNullable<SetEnabledOptions["adoption"]>,
  retirement?: Effect.Success<ReturnType<typeof planSetupAliasRetirement>>,
) {
  const state = yield* (yield* LibraryStore).load;
  const result = yield* applyLibraryBindings(state, {
    query: subjectId,
    all: false,
    allowDuplicate: selection.duplicateAction === "keep-both",
    ...(retirement
      ? {
          allowedShadowAliases: retirement.entries.map((entry) => ({
            ...entry,
            canonicalPath: selection.sourcePath,
          })),
        }
      : {}),
    selectedSkills: [selection.name],
    invocation: { subjects: [subjectId], scope: { kind: "global" }, enabled: true, dryRun: false },
    roots: options.bindings,
    variantsPath: options.bindings.variantsPath,
    adoption,
  });
  const outcome = retirement
    ? yield* retireSetupAliases(options.setup.inventory, subjectId, selection.name, retirement)
    : undefined;
  return {
    result,
    recoveryDirectories:
      retirement && outcome?.kind === "retired" ? [retirement.recoveryDirectory] : [],
    warnings:
      outcome?.kind === "preserved" ? [{ name: selection.name, message: outcome.message }] : [],
  };
});

/** Bind observed aliases to filesystem identities before approval, and verify that consent later. */
export const captureSetupAliasApproval = Effect.fn("Setup.captureAliasApproval")(function* (
  sourcePath: string,
  shadows: readonly HarnessShadow[],
  approved?: readonly SetupApprovedAlias[],
) {
  const paths = retirableShadowAliases(sourcePath, shadows);
  if (!paths.length) return yield* new PlanIsStale();
  const links = yield* LinkStat;
  const fs = yield* FileSystem.FileSystem;
  const aliases = yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      yield* leavePnpmSkillEffect(path);
      const info = yield* links.identity.lstat(path);
      if (info.type !== "SymbolicLink") return yield* new PlanIsStale();
      const canonicalPath = yield* fs.realPath(path);
      const linkTarget = yield* fs.readLink(path);
      if (
        canonicalPath !== sourcePath ||
        shadows.some((shadow) =>
          shadow.aliases.some((alias) => alias.path === path && alias.linkTarget !== linkTarget),
        )
      )
        return yield* new PlanIsStale();
      return { path, canonicalPath, linkTarget, dev: info.dev, ino: info.ino };
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(error.reason._tag === "NotFound" ? new PlanIsStale() : error),
      ),
    ),
  );
  if (
    approved &&
    !Schema.toEquivalence(Schema.Array(SetupApprovedAlias))(
      [...approved].sort((left, right) => left.path.localeCompare(right.path)),
      [...aliases].sort((left, right) => left.path.localeCompare(right.path)),
    )
  )
    return yield* new PlanIsStale();
  return aliases;
});

export const planSetupAliasRetirement = Effect.fn("Setup.planAliasRetirement")(function* (
  libraryHome: string,
  name: string,
  sourcePath: string,
  shadows: readonly HarnessShadow[],
  approvedAliases?: readonly SetupApprovedAlias[],
) {
  const aliases = yield* captureSetupAliasApproval(sourcePath, shadows, approvedAliases);
  const recoveryDirectory = join(libraryHome, "removed", randomUUID());
  const entries: SetupRemoval[] = aliases.map((alias, index) => ({
    name,
    path: alias.path,
    recoveryPath: join(recoveryDirectory, `${index + 1}-${basename(alias.path)}`),
    type: "SymbolicLink",
    dev: alias.dev,
    ino: alias.ino,
    linkTarget: alias.linkTarget,
  }));
  const harnesses = [...new Set(shadows.map((shadow) => shadow.harness).filter(hasHarnessProfile))];
  return { recoveryDirectory, entries, harnesses };
});

/** Preserve each alias until its harness has an installed replacement; unrelated targets do not gate retirement. */
export const retireSetupAliases = Effect.fn("Setup.retireAliasesAfterProjection")(function* (
  roots: InventoryRootOptions,
  subjectId: string,
  name: string,
  retirement: {
    recoveryDirectory: string;
    entries: SetupRemoval[];
    harnesses: readonly HarnessName[];
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const subject = yield* resolveLibrarySubject(state, subjectId);
  const skill = subject.skills.find((item) => item.name === name);
  const canonical = (path: string) =>
    fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
  const readableRoots = yield* Effect.forEach(
    readableHarnessRoots(roots, { kind: "global" }).filter((root) =>
      retirement.harnesses.includes(root.harness),
    ),
    (root) => canonical(root.root),
  );
  let required = 0;
  for (const target of yield* activeProjectionTargetsEffect(roots)) {
    const root = bindingRoot(target, { kind: "global" }, roots);
    if (!readableRoots.includes(yield* canonical(root))) continue;
    required++;
    const path = join(root, name);
    const expectedPath = yield* canonical(path);
    const candidates = state.projections.filter(
      (projection) => projection.skill_id === skill?.skill_id && projection.status === "installed",
    );
    const installedPaths = yield* Effect.forEach(candidates, (projection) =>
      canonical(projection.path),
    );
    if (!(yield* fs.exists(join(path, "SKILL.md"))) || !installedPaths.includes(expectedPath))
      return {
        kind: "preserved" as const,
        message: `Bound ${name}; existing aliases were preserved because the replacement at ${path} is not installed. Run skit doctor to inspect the conflict.`,
      };
  }
  if (!required)
    return {
      kind: "preserved" as const,
      message: `Bound ${name}; existing aliases were preserved because no active replacement is readable by their harness. Run skit doctor to inspect the conflict.`,
    };
  yield* applySetupRemovals(retirement);
  return { kind: "retired" as const };
});
