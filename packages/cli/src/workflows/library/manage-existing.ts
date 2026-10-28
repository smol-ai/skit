import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "../../install/roots.js";
import {
  findDuplicates,
  readableSkillsDirectories,
  type DuplicateCopy,
} from "../../install/duplicates.js";
import {
  applySetEnabledPlan,
  planSetEnabled,
  type SetEnabledRequest,
} from "../../library-application/set-enabled.js";
import { PlanIsStale } from "../../library/failures.js";
import { recordSetupCopies } from "./setup-copy-backup.js";
import { prepareRecoveryMoves } from "../../library-application/recovery-moves.js";
import { resolveLibrarySubject } from "./subject-resolution.js";
import { leavePnpmSkill } from "../../install/pnpm-skills.js";
import {
  duplicateSymlinksToBackUp,
  ApprovedSymlink,
  type SetupCopySelection,
  type SetupCopyConflict,
} from "./setup-decisions.js";
import {
  canonicalJson,
  deterministicTreeHash,
  Digest as DigestSchema,
  HarnessName,
  inspectNormalizedTree,
  inspectOwnershipMarker,
  inspectInstalledSkill,
  LibraryStore,
  LinkStat,
  hasHarnessProfile,
  withLibraryWriter,
  type Digest,
  type MachineId,
  type HarnessName as HarnessNameType,
  FailureTypeId,
  type SkitFailure,
  InstallScope,
  walkTree,
} from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { importSource, inspectLibrarySource } from "../../library-application/import-source.js";
import type { InstalledSkillOptions } from "./installed-skill-options.js";

const ManageTarget = Schema.Struct({
  path: Schema.String,
  harness: HarnessName,
  scope: InstallScope,
});
interface ManageTarget extends Schema.Schema.Type<typeof ManageTarget> {}

const ManageBlocker = Schema.Literals([
  "empty-selection",
  "multiple-skills",
  "not-projection-target",
  "content-mismatch",
  "invalid-marker",
  "managed-by-another-entry",
  "would-discard-control-entry",
  "would-normalize-path",
]);
type ManageBlocker = typeof ManageBlocker.Type;

const PlannedManageTarget = Schema.Union([
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("adoptable"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("already-managed"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...ManageTarget.fields,
    status: Schema.Literal("blocked"),
    observedHash: Schema.optionalKey(DigestSchema),
  }),
]);
type PlannedManageTarget = typeof PlannedManageTarget.Type;

const ManagePlan = Schema.Struct({
  revision: Schema.String,
  sourcePath: Schema.optionalKey(Schema.String),
  snapshotDigest: Schema.optionalKey(DigestSchema),
  skill: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      validationDigest: DigestSchema,
    }),
  ),
  targets: Schema.Array(PlannedManageTarget),
  blockers: Schema.Array(Schema.Struct({ path: Schema.String, reason: ManageBlocker })),
  applicable: Schema.Boolean,
});
interface ManagePlan extends Schema.Schema.Type<typeof ManagePlan> {}

export interface ManageOptions {
  readonly bindings: InstalledSkillOptions;
  readonly recoveryOperationDirectory?: string;
}

const manageBlockers = Effect.fn("Library.manageBlockers")(function* (root: string) {
  const normalized = yield* inspectNormalizedTree(root);
  const verbatim = yield* walkTree(root, "verbatim");
  const blockers: Array<{ path: string; reason: ManageBlocker }> = normalized.excluded
    .filter(
      (entry) =>
        entry.reason === "normalized-control-exclusion" &&
        entry.path.split("/").at(-1) !== ".DS_Store",
    )
    .map((entry) => ({
      path: join(root, entry.path),
      reason: "would-discard-control-entry" as const,
    }));

  for (const entry of verbatim) {
    if (entry.path !== entry.path.normalize("NFC"))
      blockers.push({ path: join(root, entry.path), reason: "would-normalize-path" });
  }

  return { blockers, contentHash: yield* deterministicTreeHash(root) };
});

/** Plan exact-content managing without retaining, projecting, or saving state. */
const planManage = Effect.fn("Library.planManage")(function* (
  selected: readonly ManageTarget[],
  nominatedSourcePath?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const revision = createHash("sha256").update(canonicalJson(state)).digest("hex");
  if (!selected.length) {
    const plan: ManagePlan = {
      revision,
      targets: [],
      blockers: [{ path: "", reason: "empty-selection" }],
      applicable: false,
    };
    return plan;
  }

  const targets = [...selected].sort((left, right) =>
    resolve(left.path).localeCompare(resolve(right.path)),
  );
  const sourcePath = resolve(nominatedSourcePath ?? selected[0]!.path);
  const preview = yield* inspectLibrarySource(sourcePath);
  const blockers: Array<{ path: string; reason: ManageBlocker }> = [];
  const previewSkill = preview.skills.length === 1 ? preview.skills[0] : undefined;
  const sourceContentHash = yield* deterministicTreeHash(sourcePath);
  const existingImportIds = new Set(
    state.imports
      .filter(
        (sourceImport) =>
          sourceImport.source_identity.kind === "local" &&
          resolve(sourceImport.source_identity.path.value) === sourcePath,
      )
      .map((sourceImport) => sourceImport.import_id),
  );
  const existingCollection = state.collections.find((collection) =>
    state.imports.some(
      (sourceImport) =>
        sourceImport.collection_id === collection.collection_id &&
        existingImportIds.has(sourceImport.import_id),
    ),
  );
  const existingSkill = state.skills.find(
    (candidate) =>
      candidate.collection_id === existingCollection?.collection_id &&
      candidate.name === previewSkill?.name,
  );
  const skill = previewSkill
    ? {
        name: previewSkill.name,
        ...(existingSkill === undefined ? {} : { skillId: existingSkill.skill_id }),
        validationDigest: sourceContentHash,
      }
    : undefined;
  if (!skill) blockers.push({ path: sourcePath, reason: "multiple-skills" });

  const observedTargets: PlannedManageTarget[] = [];
  for (const target of targets) {
    const path = resolve(target.path);
    const expectedPath = resolve(join(dirname(path), previewSkill?.name ?? ""));
    const physicalExpectedPath = expectedPath
      ? yield* fs.realPath(expectedPath).pipe(Effect.orElseSucceed(() => expectedPath))
      : undefined;
    const physicalTargetPath = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    if (!skill || !physicalExpectedPath || physicalExpectedPath !== physicalTargetPath) {
      blockers.push({ path, reason: "not-projection-target" });
      observedTargets.push({ ...target, path, status: "blocked" });
      continue;
    }
    const lossless = yield* manageBlockers(path);
    const observedHash = lossless.contentHash;
    let blocked = false;
    if (observedHash !== skill.validationDigest) {
      blockers.push({ path, reason: "content-mismatch" });
      blocked = true;
    }
    const marker = yield* inspectOwnershipMarker(path);
    const alreadyManaged =
      marker.kind === "valid" &&
      skill.skillId !== undefined &&
      marker.marker.skill_id === skill.skillId &&
      marker.marker.expected_digest === observedHash;
    if (!alreadyManaged && lossless.blockers.length > 0) {
      blockers.push(...lossless.blockers);
      blocked = true;
    }
    if (marker.kind === "invalid") {
      blockers.push({ path, reason: "invalid-marker" });
      blocked = true;
    }
    if (marker.kind === "valid" && !alreadyManaged) {
      blockers.push({ path, reason: "managed-by-another-entry" });
      blocked = true;
    }
    observedTargets.push({
      ...target,
      path,
      observedHash,
      status: blocked ? "blocked" : alreadyManaged ? "already-managed" : "adoptable",
    });
  }

  const plan: ManagePlan = {
    revision,
    sourcePath,
    snapshotDigest: preview.snapshot_digest,
    ...(skill ? { skill } : {}),
    targets: observedTargets,
    blockers,
    applicable: blockers.length === 0,
  };
  return plan;
});

export class ManageInvalid
  extends Schema.TaggedError<ManageInvalid>()("ManageInvalid", {
    name: Schema.String,
    reason: Schema.Literals(["source-not-candidate", "machine-identity-required"]),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message() {
    return `Cannot manage ${this.name}: ${this.reason}`;
  }
}

/** Setup selects eligibility; managing owns retaining or reusing content and taking ownership. */
export type ManageRequest =
  | { readonly kind: "existing"; readonly subjectId: string; readonly observedHash: Digest }
  | {
      readonly kind: "retain";
      readonly observedHash: Digest | undefined;
      readonly ownership?: {
        readonly harnesses: readonly HarnessNameType[];
        readonly machineId: MachineId | undefined;
      };
      /**
       * Other copies setup observed with exactly these bytes. Where one sits at a target's
       * destination it is managed in place, rather than left for that target to conflict with.
       */
      readonly equalCopies?: readonly string[];
    };

/**
 * Check one selection's duplicate decision against the scan, and record the exact duplicate
 * copies or symlinks it approves. Setup checks every selection before managing any of them.
 */
export const checkManageSelection = Effect.fn("Manage.checkSelection")(function* <E>(
  selection: SetupCopySelection,
  conflict: SetupCopyConflict,
  invalid: (
    reason:
      | "duplicate-action-required"
      | "aliases-not-retirable"
      | "copies-not-preservable"
      | "keep-both-replaces-link",
  ) => E,
) {
  if (conflict.kind !== "none" && !selection.duplicateAction)
    return yield* Effect.fail(invalid("duplicate-action-required"));
  // A link at SKIT's destination is replaced by the copy, so the two cannot both stay.
  if (
    conflict.kind !== "none" &&
    conflict.replacesLink &&
    selection.duplicateAction === "keep-both"
  )
    return yield* Effect.fail(invalid("keep-both-replaces-link"));
  if (selection.duplicateAction === "preserve-duplicates") {
    if (conflict.kind !== "preservable")
      return yield* Effect.fail(invalid("copies-not-preservable"));
    return {
      ...selection,
      duplicateAction: selection.duplicateAction,
      approvedCopies: yield* recordSetupCopies(
        selection.sourcePath,
        conflict.duplicates,
        selection.approvedCopies,
      ),
    };
  }
  if (selection.duplicateAction !== "retire-aliases")
    return { ...selection, duplicateAction: selection.duplicateAction };
  if (conflict.kind !== "retirable")
    return yield* Effect.fail(
      selection.approvedSymlinks ? new PlanIsStale() : invalid("aliases-not-retirable"),
    );
  return {
    ...selection,
    duplicateAction: selection.duplicateAction,
    approvedSymlinks: yield* recordDuplicateSymlinks(
      selection.sourcePath,
      conflict.duplicates,
      selection.approvedSymlinks,
    ),
  };
});

/**
 * Manage one existing copy under the Library writer: check it still matches the scan, import its
 * files (a new copy only), install it, then back up its duplicates once every agent can read the
 * new copy.
 */
export const manageCopy = Effect.fn("Manage.copy")(function* (
  options: ManageOptions,
  selection: Effect.Success<ReturnType<typeof checkManageSelection>>,
  request: ManageRequest,
) {
  const empty = {
    result: undefined,
    recoveryDirectories: [] as string[],
    warnings: [] as { name: string; message: string }[],
  };
  const installing =
    selection.duplicateAction !== "retain-only" &&
    (request.kind === "existing" || request.ownership !== undefined);
  if (request.kind === "existing" && !installing) return empty;
  // Check: the copy, and every equal copy it brings along, still has the scanned bytes.
  const observedHash = request.observedHash;
  if (
    observedHash === undefined ||
    (request.kind === "retain" &&
      (yield* deterministicTreeHash(selection.sourcePath)) !== observedHash)
  )
    return yield* new PlanIsStale();
  const backup = installing
    ? yield* planDuplicateBackup(options.bindings, selection, options.recoveryOperationDirectory)
    : undefined;
  if (request.kind === "retain" && !installing) {
    const imported = yield* importSource(selection.sourcePath);
    if (imported.collection_id === undefined)
      return yield* new ManageInvalid({ name: selection.name, reason: "source-not-candidate" });
    return empty;
  }
  const equalPaths = request.kind === "retain" ? (request.equalCopies ?? []) : [];
  for (const path of equalPaths)
    if ((yield* deterministicTreeHash(path)) !== observedHash) return yield* new PlanIsStale();
  const manage = { path: selection.sourcePath, equalPaths, observedHash };
  let subjectId: string;
  if (request.kind === "existing") subjectId = request.subjectId;
  else {
    // Import: a new copy's files enter the Library before it is installed.
    const targets = (request.ownership?.harnesses ?? []).map((harness) => ({
      path: selection.sourcePath,
      harness,
      scope: { kind: "global" as const },
    }));
    const plan = yield* planManage(targets, selection.sourcePath);
    if (
      plan.targets.some((target) => target.status === "adoptable") &&
      !request.ownership?.machineId
    )
      return yield* new ManageInvalid({
        name: selection.name,
        reason: "machine-identity-required",
      });
    if (!plan.applicable || !plan.sourcePath || !plan.skill)
      return yield* new ManageInvalid({ name: selection.name, reason: "source-not-candidate" });
    const imported = yield* importSource(plan.sourcePath);
    if (imported.collection_id === undefined)
      return yield* new ManageInvalid({ name: selection.name, reason: "source-not-candidate" });
    subjectId = imported.collection_id;
    manage.path = plan.sourcePath;
    manage.observedHash = plan.skill.validationDigest;
  }
  return yield* installCopy(options.bindings, selection, subjectId, manage, backup);
}, withLibraryWriter);

/** Capture duplicate preservation before managing or binding. */
const planDuplicateBackup = Effect.fn("Manage.planDuplicateBackup")(function* (
  roots: InventoryRootOptions,
  selection: Effect.Success<ReturnType<typeof checkManageSelection>>,
  operationDirectory?: string,
) {
  if (selection.duplicateAction === "preserve-duplicates") {
    const duplicates = yield* findDuplicates(roots, { kind: "global" }, [selection.name]);
    const copies = yield* recordSetupCopies(
      selection.sourcePath,
      duplicates,
      selection.approvedCopies,
    );
    const store = yield* LibraryStore;
    const moves = yield* prepareRecoveryMoves(
      store.home,
      copies.map((copy) => ({
        name: selection.name,
        path: copy.path,
        observedHash: copy.observedHash,
      })),
      operationDirectory,
    );
    return {
      moves: {
        ...moves,
        apply: () =>
          Effect.gen(function* () {
            yield* recordSetupCopies(selection.sourcePath, duplicates, copies);
            yield* moves.apply();
          }),
      },
      symlinks: [] as readonly ApprovedSymlink[],
      harnesses: [
        ...new Set(duplicates.map((duplicate) => duplicate.harness).filter(hasHarnessProfile)),
      ],
    };
  }
  if (selection.duplicateAction !== "retire-aliases") return undefined;
  const approvedSymlinks: readonly ApprovedSymlink[] = selection.approvedSymlinks;
  const duplicates = yield* findDuplicates(roots, { kind: "global" }, [selection.name]);
  // A link at SKIT's own destination is replaced by the installed skill itself, which keeps it in that
  // root's backups; moving it afterwards would find the new copy there instead.
  const destinations = (yield* activeInstallDestinations(roots)).map((target) =>
    join(skillsDirectoryFor(target, { kind: "global" }, roots), selection.name),
  );
  const store = yield* LibraryStore;
  return yield* planSymlinkBackup(
    store.home,
    selection.name,
    selection.sourcePath,
    duplicates,
    approvedSymlinks,
    destinations,
    operationDirectory,
  );
});

/** Install the copy, then back up its duplicates using the approval recorded before. */
const installCopy = Effect.fn("Manage.installCopy")(function* (
  roots: InventoryRootOptions,
  selection: SetupCopySelection,
  subjectId: string,
  manage: NonNullable<SetEnabledRequest["manage"]>,
  backup?: NonNullable<Effect.Success<ReturnType<typeof planDuplicateBackup>>>,
) {
  const plan = yield* planSetEnabled(
    [
      {
        query: subjectId,
        keepUnselectedInstalledSkills: true,
        all: false,
        allowDuplicate:
          selection.duplicateAction === "keep-both" ||
          selection.duplicateAction === "preserve-duplicates",
        ...(backup
          ? {
              allowedDuplicateSymlinks: backup.symlinks.map((entry) => ({
                ...entry,
                canonicalPath: selection.sourcePath,
              })),
            }
          : {}),
        selectedSkills: [selection.name],
        scope: { kind: "global" },
        enabled: true,
        manage,
      },
    ],
    roots,
  );
  const applied = yield* applySetEnabledPlan(plan).pipe(
    Effect.map((results) => ({ results, warnings: [] as { name: string; message: string }[] })),
    Effect.catchTag("Library.SetEnabledIncomplete", (failure) =>
      // Setup can retain the chosen source while other differing copies stay active.
      // Report the owner's incomplete destinations; actual reconciliation failures stop setup.
      failure.reason === "destinations"
        ? Effect.succeed({
            results: failure.results.map((value) => ({ kind: "applied" as const, value })),
            warnings: [{ name: selection.name, message: failure.message }],
          })
        : Effect.fail(failure),
    ),
  );
  const [result] = applied.results;
  const outcome = backup
    ? yield* backUpDuplicates(roots, subjectId, selection.name, backup)
    : undefined;
  return {
    result,
    recoveryDirectories:
      backup && outcome?.kind === "retired" && backup.moves.entries.length
        ? [backup.moves.recoveryDirectory]
        : [],
    warnings: [
      ...applied.warnings,
      ...(outcome?.kind === "preserved"
        ? [{ name: selection.name, message: outcome.message }]
        : []),
    ],
  };
});

/** Bind observed symlinks to filesystem identities before approval, and verify that consent later. */
export const recordDuplicateSymlinks = Effect.fn("Manage.recordDuplicateSymlinks")(function* (
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approved?: readonly ApprovedSymlink[],
) {
  const paths = duplicateSymlinksToBackUp(sourcePath, duplicates);
  if (!paths.length) return yield* new PlanIsStale();
  const links = yield* LinkStat;
  const fs = yield* FileSystem.FileSystem;
  const symlinks = yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      yield* leavePnpmSkill(path);
      const info = yield* links.identity.lstat(path);
      if (info.type !== "SymbolicLink") return yield* new PlanIsStale();
      const canonicalPath = yield* fs.realPath(path);
      const linkTarget = yield* fs.readLink(path);
      if (
        canonicalPath !== sourcePath ||
        duplicates.some((duplicate) =>
          duplicate.aliases.some((alias) => alias.path === path && alias.linkTarget !== linkTarget),
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
    !Schema.toEquivalence(Schema.Array(ApprovedSymlink))(
      [...approved].sort((left, right) => left.path.localeCompare(right.path)),
      [...symlinks].sort((left, right) => left.path.localeCompare(right.path)),
    )
  )
    return yield* new PlanIsStale();
  return symlinks;
});

const planSymlinkBackup = Effect.fn("Manage.planSymlinkBackup")(function* (
  libraryHome: string,
  name: string,
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approvedSymlinks: readonly ApprovedSymlink[] | undefined,
  destinations: readonly string[],
  operationDirectory?: string,
) {
  const symlinks = yield* recordDuplicateSymlinks(sourcePath, duplicates, approvedSymlinks);
  const moves = yield* prepareRecoveryMoves(
    libraryHome,
    symlinks
      .filter((symlink) => !destinations.includes(symlink.path))
      .map((symlink) => ({
        name,
        path: symlink.path,
        approvedLink: symlink,
      })),
    operationDirectory,
  );
  const harnesses = [
    ...new Set(duplicates.map((duplicate) => duplicate.harness).filter(hasHarnessProfile)),
  ];
  return { moves, symlinks, harnesses };
});

/** Existing entries stay active until every affected reader has a verified replacement. */
const backUpDuplicates = Effect.fn("Manage.backUpDuplicates")(function* (
  roots: InventoryRootOptions,
  subjectId: string,
  name: string,
  backup: NonNullable<Effect.Success<ReturnType<typeof planDuplicateBackup>>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const subject = yield* resolveLibrarySubject(state, subjectId);
  const skill = subject.skills.find((item) => item.name === name);
  const canonical = (path: string) =>
    fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
  const readableRoots = yield* Effect.forEach(
    readableSkillsDirectories(roots, { kind: "global" }).filter((root) =>
      backup.harnesses.includes(root.harness),
    ),
    (root) => canonical(root.root),
  );
  let required = 0;
  for (const target of yield* activeInstallDestinations(roots)) {
    const root = skillsDirectoryFor(target, { kind: "global" }, roots);
    if (!readableRoots.includes(yield* canonical(root))) continue;
    required++;
    const path = join(root, name);
    const expectedPath = yield* canonical(path);
    const candidates = state.installed_skills.filter(
      (installedSkill) =>
        installedSkill.skill_id === skill?.skill_id && installedSkill.status === "installed",
    );
    const installedPaths = yield* Effect.forEach(candidates, (installedSkill) =>
      canonical(installedSkill.path),
    );
    if (!(yield* fs.exists(join(path, "SKILL.md"))) || !installedPaths.includes(expectedPath))
      return {
        kind: "preserved" as const,
        message: `Bound ${name}; existing copies were left in place because the replacement at ${path} is not installed. Run skit doctor to inspect the conflict.`,
      };
    const installedSkill = candidates.find((candidate) => candidate.path === path);
    const ownership = installedSkill ? yield* inspectInstalledSkill(installedSkill) : undefined;
    if (
      !installedSkill ||
      ownership?.kind !== "intact" ||
      ownership.observed !== installedSkill.expected_digest ||
      ownership.marker.expected_digest !== installedSkill.expected_digest ||
      ownership.marker.skill_version_id !== installedSkill.skill_version_id ||
      (yield* (yield* LinkStat).lstat(path)).type !== "Directory"
    )
      return {
        kind: "preserved" as const,
        message: `Bound ${name}; existing copies remain because the replacement at ${path} changed before preservation.`,
      };
  }
  if (!required)
    return {
      kind: "preserved" as const,
      message: `Bound ${name}; existing copies were left in place because no active replacement is readable by their harness. Run skit doctor to inspect the conflict.`,
    };
  yield* backup.moves.apply();
  return { kind: "retired" as const };
});
