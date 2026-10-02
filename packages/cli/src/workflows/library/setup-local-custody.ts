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
  type LocalAdoptionPlan,
  type LocalAdoptionTarget,
} from "./local-adoption.js";
import { PlanIsStale } from "../../library/failures.js";
import { addLibrarySourceEffect } from "./add.js";
import { applyLibraryBindings } from "./set-enabled.js";
import { revalidateSetupPlan, type SetupOptions } from "./setup.js";

export const SetupLocalCustodySelection = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  duplicateAction: Schema.optionalKey(
    Schema.Literals(["retain-only", "retire-aliases", "keep-both"]),
  ),
});
export interface SetupLocalCustodySelection extends Schema.Schema.Type<
  typeof SetupLocalCustodySelection
> {}

const SetupLocalCustodySelections = Schema.Array(SetupLocalCustodySelection);

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
  selectionInput: readonly SetupLocalCustodySelection[],
) {
  const selections = yield* Schema.decodeUnknownEffect(SetupLocalCustodySelections)(selectionInput);
  const current = yield* revalidateSetupPlan(options.setup, approvedPlanId);
  yield* (yield* LibraryStore).load;
  for (const selection of selections) {
    const candidate = current.onboarding.candidates.find(
      (item) => item.name === selection.name && item.paths.includes(selection.sourcePath),
    );
    const instance = current.instances.find((item) => item.path === selection.sourcePath);
    const willEnable =
      instance?.scope === "global" && !instance.git.repository && instance.harnesses.length > 0;
    if (willEnable && candidate?.shadows?.length && !selection.duplicateAction)
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "duplicate-action-required",
      });
    if (
      selection.duplicateAction === "retire-aliases" &&
      !retirableShadowAliases(selection.sourcePath, candidate?.shadows ?? []).length
    )
      return yield* new SetupLocalCustodySelectionInvalid({
        name: selection.name,
        reason: "aliases-not-retirable",
      });
  }
  const selectedCandidates = new Set<string>();
  const adopted: Array<{ readonly subject_id: string; readonly retained_version_id: string }> = [];
  const plans: Array<{ name: string; plan: LocalAdoptionPlan }> = [];
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
      selectedInstance?.git.repository ||
      selectedInstance?.scope !== "global" ||
      selectedInstance.harnesses.length === 0
    ) {
      const retained = yield* addLibrarySourceEffect(sourcePath);
      if (retained.collection_id === undefined)
        return yield* new SetupLocalCustodySelectionInvalid({
          name: selection.name,
          reason: "source-not-candidate",
        });
      adopted.push({
        subject_id: retained.collection_id,
        retained_version_id: retained.retained_version_id,
      });
      continue;
    }
    const shadows = yield* observeHarnessShadows(options.setup.inventory, { kind: "global" }, [
      selection.name,
    ]);
    const retirement =
      selection.duplicateAction === "retire-aliases"
        ? yield* planSetupAliasRetirement(
            options.setup.libraryHome,
            selection.name,
            sourcePath,
            shadows,
          )
        : undefined;
    // An explicit row selects only that physical copy. Differing siblings remain untouched.
    const targets: LocalAdoptionTarget[] = selectedInstance.harnesses.map((harness) => ({
      path: sourcePath,
      harness,
      scope: { kind: "global" },
    }));
    const adoptionPlan = yield* planLocalAdoption(options.adoption, targets, sourcePath);
    plans.push({ name: selection.name, plan: adoptionPlan });
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
    const state = yield* (yield* LibraryStore).load;
    yield* applyLibraryBindings(state, {
      query: subjectId,
      all: false,
      allowDuplicate: selection.duplicateAction === "keep-both",
      ...(retirement
        ? {
            allowedShadowAliases: retirement.entries.map((entry) => ({
              ...entry,
              canonicalPath: sourcePath,
            })),
          }
        : {}),
      selectedSkills: [selection.name],
      invocation: {
        subjects: [subjectId],
        scope: { kind: "global" },
        enabled: true,
        dryRun: false,
      },
      roots: options.adoption.bindings,
      variantsPath: options.adoption.bindings.variantsPath,
      adoption: {
        path: adoptionPlan.sourcePath,
        observedHash: adoptionPlan.skill.validationDigest,
      },
    });
    if (retirement) {
      const outcome = yield* retireSetupAliases(
        options.setup.inventory,
        subjectId,
        selection.name,
        retirement,
      );
      if (outcome.kind === "retired") recoveryDirectories.push(retirement.recoveryDirectory);
      else warnings.push({ name: selection.name, message: outcome.message });
    }
    adopted.push({
      subject_id: subjectId,
      retained_version_id: retained.retained_version_id,
    });
  }
  return { planId: current.onboarding.planId, plans, adopted, recoveryDirectories, warnings };
});

/** Only individual links to this retained source can be retired by the duplicate choice. */
export function retirableShadowAliases(sourcePath: string, shadows: readonly HarnessShadow[]) {
  if (
    !shadows.length ||
    shadows.some(
      (shadow) =>
        shadow.canonicalPath !== sourcePath ||
        shadow.aliases.some((alias) => alias.via !== "symlink" || alias.linkPath !== alias.path),
    )
  )
    return [];
  return [
    ...new Set(shadows.flatMap((shadow) => shadow.aliases.map((alias) => alias.path))),
  ].sort();
}

export const planSetupAliasRetirement = Effect.fn("Setup.planAliasRetirement")(function* (
  libraryHome: string,
  name: string,
  sourcePath: string,
  shadows: readonly HarnessShadow[],
) {
  const paths = retirableShadowAliases(sourcePath, shadows);
  if (!paths.length) return yield* new PlanIsStale();
  const links = yield* LinkStat;
  const fs = yield* FileSystem.FileSystem;
  const recoveryDirectory = join(libraryHome, "removed", randomUUID());
  const entries: SetupRemoval[] = [];
  for (const path of paths) {
    const info = yield* links.identity.lstat(path);
    if (info.type !== "SymbolicLink" || (yield* fs.realPath(path)) !== sourcePath)
      return yield* new PlanIsStale();
    entries.push({
      name,
      path,
      recoveryPath: join(recoveryDirectory, `${entries.length + 1}-${basename(path)}`),
      type: "SymbolicLink",
      dev: info.dev,
      ino: info.ino,
      linkTarget: yield* fs.readLink(path),
    });
  }
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
