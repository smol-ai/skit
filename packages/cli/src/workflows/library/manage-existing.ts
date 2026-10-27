import {
  activeInstallDestinationsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import {
  findDuplicates,
  readableSkillsDirectories,
  type DuplicateCopy,
} from "../../projection/duplicates.js";
import {
  applyBindingChanges,
  previewBindingChanges,
  type BindingChangeRequest,
} from "../../library-application/binding-changes.js";
import { PlanIsStale } from "../../library/failures.js";
import { captureSetupCopies } from "./setup-copy-preservation.js";
import { prepareRecoveryMoves } from "../../library-application/recovery-moves.js";
import { resolveLibrarySubject } from "./subject-resolution.js";
import { leavePnpmSkill } from "../../projection/pnpm-skills.js";
import {
  retirableDuplicateLinks,
  SetupApprovedAlias,
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
  SkitBindingScope,
  walkTree,
} from "@smolai/skit-core";
import { Effect, FileSystem, Schema } from "effect";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  retainLibrarySource,
  inspectLibrarySource,
} from "../../library-application/retain-source.js";
import type { InstalledSkillOptions } from "./installed-skill-options.js";

const ManageTarget = Schema.Struct({
  path: Schema.String,
  harness: HarnessName,
  scope: SkitBindingScope,
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
  const existingAcquisitionIds = new Set(
    state.acquisitions
      .filter(
        (acquisition) =>
          acquisition.source_identity.kind === "local" &&
          resolve(acquisition.source_identity.path.value) === sourcePath,
      )
      .map((acquisition) => acquisition.acquisition_id),
  );
  const existingCollection = state.collections.find((collection) =>
    state.acquisitions.some(
      (acquisition) =>
        acquisition.collection_id === collection.collection_id &&
        existingAcquisitionIds.has(acquisition.acquisition_id),
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

const managePlanId = (plan: ManagePlan) =>
  createHash("sha256")
    .update(
      canonicalJson({
        revision: plan.revision,
        sourcePath: plan.sourcePath,
        snapshotDigest: plan.snapshotDigest,
        skill: plan.skill,
        targets: plan.targets,
        blockers: plan.blockers,
        applicable: plan.applicable,
      }),
    )
    .digest("hex");

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

/** Validate every duplicate decision before applying any of the selected copies. */
export const approveManage = Effect.fn("Manage.approve")(function* <E>(
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
      approvedCopies: yield* captureSetupCopies(
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
      selection.approvedAliases ? new PlanIsStale() : invalid("aliases-not-retirable"),
    );
  return {
    ...selection,
    duplicateAction: selection.duplicateAction,
    approvedAliases: yield* captureManageLinks(
      selection.sourcePath,
      conflict.duplicates,
      selection.approvedAliases,
    ),
  };
});

/** Prepare without changing ownership. Apply revalidates content under the same Library writer. */
export const prepareManage = Effect.fn("Manage.prepare")(function* (
  options: ManageOptions,
  approved: Effect.Success<ReturnType<typeof approveManage>>,
  requestInput: ManageRequest,
) {
  const home = (yield* LibraryStore).home;
  const operationDirectory = options.recoveryOperationDirectory;
  const selection = structuredClone(approved);
  const request = structuredClone(requestInput);
  const bindings = {
    home: options.bindings.home,
    configHome: options.bindings.configHome,
    overrides: structuredClone(options.bindings.overrides),
  };
  const binding =
    selection.duplicateAction !== "retain-only" &&
    (request.kind === "existing" || request.ownership !== undefined);
  return {
    apply: Effect.fn("Manage.apply")(function* () {
      if ((yield* LibraryStore).home !== home) return yield* new PlanIsStale();
      const empty = {
        result: undefined,
        recoveryDirectories: [] as string[],
        warnings: [] as { name: string; message: string }[],
      };
      if (request.kind === "existing" && !binding) return empty;
      const observedHash = request.observedHash;
      if (
        observedHash === undefined ||
        (request.kind === "retain" &&
          (yield* deterministicTreeHash(selection.sourcePath)) !== observedHash)
      )
        return yield* new PlanIsStale();
      const retirement = binding
        ? yield* prepareDuplicatePreservation(bindings, selection, operationDirectory)
        : undefined;
      if (request.kind === "retain" && !binding) {
        const retained = yield* retainLibrarySource(selection.sourcePath);
        if (retained.collection_id === undefined)
          return yield* new ManageInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        return empty;
      }
      const equalPaths = request.kind === "retain" ? (request.equalCopies ?? []) : [];
      for (const path of equalPaths)
        if ((yield* deterministicTreeHash(path)) !== observedHash) return yield* new PlanIsStale();
      const manage = { path: selection.sourcePath, equalPaths, observedHash };
      let subjectId: string;
      if (request.kind === "existing") subjectId = request.subjectId;
      else {
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
          return yield* new ManageInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        const refreshed = yield* planManage(plan.targets, plan.sourcePath);
        if (managePlanId(refreshed) !== managePlanId(plan)) return yield* new PlanIsStale();
        const retained = yield* retainLibrarySource(plan.sourcePath);
        if (retained.collection_id === undefined)
          return yield* new ManageInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        subjectId = retained.collection_id;
        manage.path = plan.sourcePath;
        manage.observedHash = plan.skill.validationDigest;
      }
      return yield* bindCopy(bindings, selection, subjectId, manage, retirement);
    }, withLibraryWriter),
  };
});

/** Capture duplicate preservation before managing or binding. */
const prepareDuplicatePreservation = Effect.fn("Manage.prepareDuplicatePreservation")(function* (
  roots: InventoryRootOptions,
  selection: Effect.Success<ReturnType<typeof approveManage>>,
  operationDirectory?: string,
) {
  if (selection.duplicateAction === "preserve-duplicates") {
    const duplicates = yield* findDuplicates(roots, { kind: "global" }, [selection.name]);
    const copies = yield* captureSetupCopies(
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
            yield* captureSetupCopies(selection.sourcePath, duplicates, copies);
            yield* moves.apply();
          }),
      },
      aliases: [] as readonly SetupApprovedAlias[],
      harnesses: [
        ...new Set(duplicates.map((duplicate) => duplicate.harness).filter(hasHarnessProfile)),
      ],
    };
  }
  if (selection.duplicateAction !== "retire-aliases") return undefined;
  const approvedAliases: readonly SetupApprovedAlias[] = selection.approvedAliases;
  const duplicates = yield* findDuplicates(roots, { kind: "global" }, [selection.name]);
  // A link at SKIT's own destination is replaced by the installed skill itself, which keeps it in that
  // root's backups; moving it afterwards would find the new copy there instead.
  const destinations = (yield* activeInstallDestinationsEffect(roots)).map((target) =>
    join(bindingRoot(target, { kind: "global" }, roots), selection.name),
  );
  const store = yield* LibraryStore;
  return yield* planAliasRetirement(
    store.home,
    selection.name,
    selection.sourcePath,
    duplicates,
    approvedAliases,
    destinations,
    operationDirectory,
  );
});

/** Bind before preserving any displaced entry, using approval captured before managing. */
const bindCopy = Effect.fn("Manage.bindCopy")(function* (
  roots: InventoryRootOptions,
  selection: SetupCopySelection,
  subjectId: string,
  manage: NonNullable<BindingChangeRequest["manage"]>,
  retirement?: NonNullable<Effect.Success<ReturnType<typeof prepareDuplicatePreservation>>>,
) {
  const plan = yield* previewBindingChanges(
    [
      {
        query: subjectId,
        preserveUnselectedProjections: true,
        all: false,
        allowDuplicate:
          selection.duplicateAction === "keep-both" ||
          selection.duplicateAction === "preserve-duplicates",
        ...(retirement
          ? {
              allowedDuplicateLinks: retirement.aliases.map((entry) => ({
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
  const applied = yield* applyBindingChanges(plan).pipe(
    Effect.map((results) => ({ results, warnings: [] as { name: string; message: string }[] })),
    Effect.catchTag("Library.BindingChangeIncomplete", (failure) =>
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
  const outcome = retirement
    ? yield* preserveAfterInstalledSkill(roots, subjectId, selection.name, retirement)
    : undefined;
  return {
    result,
    recoveryDirectories:
      retirement && outcome?.kind === "retired" && retirement.moves.entries.length
        ? [retirement.moves.recoveryDirectory]
        : [],
    warnings: [
      ...applied.warnings,
      ...(outcome?.kind === "preserved"
        ? [{ name: selection.name, message: outcome.message }]
        : []),
    ],
  };
});

/** Bind observed aliases to filesystem identities before approval, and verify that consent later. */
export const captureManageLinks = Effect.fn("Manage.captureAliasApproval")(function* (
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approved?: readonly SetupApprovedAlias[],
) {
  const paths = retirableDuplicateLinks(sourcePath, duplicates);
  if (!paths.length) return yield* new PlanIsStale();
  const links = yield* LinkStat;
  const fs = yield* FileSystem.FileSystem;
  const aliases = yield* Effect.forEach(paths, (path) =>
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
    !Schema.toEquivalence(Schema.Array(SetupApprovedAlias))(
      [...approved].sort((left, right) => left.path.localeCompare(right.path)),
      [...aliases].sort((left, right) => left.path.localeCompare(right.path)),
    )
  )
    return yield* new PlanIsStale();
  return aliases;
});

const planAliasRetirement = Effect.fn("Manage.planAliasRetirement")(function* (
  libraryHome: string,
  name: string,
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approvedAliases: readonly SetupApprovedAlias[] | undefined,
  destinations: readonly string[],
  operationDirectory?: string,
) {
  const aliases = yield* captureManageLinks(sourcePath, duplicates, approvedAliases);
  const moves = yield* prepareRecoveryMoves(
    libraryHome,
    aliases
      .filter((alias) => !destinations.includes(alias.path))
      .map((alias) => ({
        name,
        path: alias.path,
        approvedLink: alias,
      })),
    operationDirectory,
  );
  const harnesses = [
    ...new Set(duplicates.map((duplicate) => duplicate.harness).filter(hasHarnessProfile)),
  ];
  return { moves, aliases, harnesses };
});

/** Existing entries stay active until every affected reader has a verified replacement. */
const preserveAfterInstalledSkill = Effect.fn("Manage.preserveCopiesAfterInstall")(function* (
  roots: InventoryRootOptions,
  subjectId: string,
  name: string,
  retirement: NonNullable<Effect.Success<ReturnType<typeof prepareDuplicatePreservation>>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const subject = yield* resolveLibrarySubject(state, subjectId);
  const skill = subject.skills.find((item) => item.name === name);
  const canonical = (path: string) =>
    fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
  const readableRoots = yield* Effect.forEach(
    readableSkillsDirectories(roots, { kind: "global" }).filter((root) =>
      retirement.harnesses.includes(root.harness),
    ),
    (root) => canonical(root.root),
  );
  let required = 0;
  for (const target of yield* activeInstallDestinationsEffect(roots)) {
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
        message: `Bound ${name}; existing copies were left in place because the replacement at ${path} is not installed. Run skit doctor to inspect the conflict.`,
      };
    const projection = candidates.find((candidate) => candidate.path === path);
    const ownership = projection ? yield* inspectInstalledSkill(projection) : undefined;
    if (
      !projection ||
      ownership?.kind !== "intact" ||
      ownership.observed !== projection.expected_digest ||
      ownership.marker.expected_digest !== projection.expected_digest ||
      ownership.marker.skill_version_id !== projection.skill_version_id ||
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
  yield* retirement.moves.apply();
  return { kind: "retired" as const };
});
