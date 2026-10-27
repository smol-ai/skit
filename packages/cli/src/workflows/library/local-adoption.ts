import {
  activeInstallDestinationsEffect,
  bindingRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import {
  observeHarnessShadows,
  readableSkillsDirectories,
  type HarnessShadow,
} from "../../projection/harness-shadows.js";
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
  retirableShadowAliases,
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
  installedSkillCustody,
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

const LocalAdoptionTarget = Schema.Struct({
  path: Schema.String,
  harness: HarnessName,
  scope: SkitBindingScope,
});
interface LocalAdoptionTarget extends Schema.Schema.Type<typeof LocalAdoptionTarget> {}

const LocalAdoptionBlockerReason = Schema.Literals([
  "empty-selection",
  "multiple-skills",
  "not-projection-target",
  "content-mismatch",
  "invalid-marker",
  "managed-by-another-entry",
  "would-discard-control-entry",
  "would-normalize-path",
]);
type LocalAdoptionBlockerReason = typeof LocalAdoptionBlockerReason.Type;

const LocalAdoptionPlannedTarget = Schema.Union([
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("adoptable"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("already-managed"),
    observedHash: DigestSchema,
  }),
  Schema.Struct({
    ...LocalAdoptionTarget.fields,
    status: Schema.Literal("blocked"),
    observedHash: Schema.optionalKey(DigestSchema),
  }),
]);
type LocalAdoptionPlannedTarget = typeof LocalAdoptionPlannedTarget.Type;

const LocalAdoptionPlan = Schema.Struct({
  revision: Schema.String,
  sourcePath: Schema.optionalKey(Schema.String),
  snapshotDigest: Schema.optionalKey(DigestSchema),
  skill: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      validationDigest: DigestSchema,
    }),
  ),
  targets: Schema.Array(LocalAdoptionPlannedTarget),
  blockers: Schema.Array(
    Schema.Struct({ path: Schema.String, reason: LocalAdoptionBlockerReason }),
  ),
  applicable: Schema.Boolean,
});
interface LocalAdoptionPlan extends Schema.Schema.Type<typeof LocalAdoptionPlan> {}

export interface LocalAdoptionOptions {
  readonly bindings: InstalledSkillOptions;
  readonly recoveryOperationDirectory?: string;
}

const losslessAdoptionBlockers = Effect.fn("Library.inspectLosslessAdoption")(function* (
  root: string,
) {
  const normalized = yield* inspectNormalizedTree(root);
  const verbatim = yield* walkTree(root, "verbatim");
  const blockers: Array<{ path: string; reason: LocalAdoptionBlockerReason }> = normalized.excluded
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

/** Plan exact-content Custody transfer without retaining, projecting, or saving state. */
const planLocalAdoption = Effect.fn("Library.planLocalAdoption")(function* (
  selected: readonly LocalAdoptionTarget[],
  nominatedSourcePath?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* (yield* LibraryStore).load;
  const revision = createHash("sha256").update(canonicalJson(state)).digest("hex");
  if (!selected.length) {
    const plan: LocalAdoptionPlan = {
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
  const blockers: Array<{ path: string; reason: LocalAdoptionBlockerReason }> = [];
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

  const observedTargets: LocalAdoptionPlannedTarget[] = [];
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
    const lossless = yield* losslessAdoptionBlockers(path);
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

  const plan: LocalAdoptionPlan = {
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

const localAdoptionPlanIdentity = (plan: LocalAdoptionPlan) =>
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

export class LocalAdoptionInvalid
  extends Schema.TaggedError<LocalAdoptionInvalid>()("LocalAdoptionInvalid", {
    name: Schema.String,
    reason: Schema.Literals(["source-not-candidate", "machine-identity-required"]),
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message() {
    return `Cannot take custody of ${this.name}: ${this.reason}`;
  }
}

/** Setup selects eligibility; adoption owns retaining or reusing content and taking custody. */
export type LocalAdoptionRequest =
  | { readonly kind: "existing"; readonly subjectId: string; readonly observedHash: Digest }
  | {
      readonly kind: "retain";
      readonly observedHash: Digest | undefined;
      readonly custody?: {
        readonly harnesses: readonly HarnessNameType[];
        readonly machineId: MachineId | undefined;
      };
      /**
       * Other copies setup observed with exactly these bytes. Where one sits at a target's
       * destination it is adopted in place, rather than left for that target to conflict with.
       */
      readonly equalCopies?: readonly string[];
    };

/** Validate every duplicate decision before applying any of the selected copies. */
export const approveLocalAdoption = Effect.fn("LocalAdoption.approve")(function* <E>(
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
        conflict.shadows,
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
    approvedAliases: yield* captureLocalAdoptionAliases(
      selection.sourcePath,
      conflict.shadows,
      selection.approvedAliases,
    ),
  };
});

/** Prepare without changing custody. Apply revalidates content under the same Library writer. */
export const prepareLocalAdoption = Effect.fn("LocalAdoption.prepare")(function* (
  options: LocalAdoptionOptions,
  approved: Effect.Success<ReturnType<typeof approveLocalAdoption>>,
  requestInput: LocalAdoptionRequest,
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
    (request.kind === "existing" || request.custody !== undefined);
  return {
    apply: Effect.fn("LocalAdoption.apply")(function* () {
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
          return yield* new LocalAdoptionInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        return empty;
      }
      const equalPaths = request.kind === "retain" ? (request.equalCopies ?? []) : [];
      for (const path of equalPaths)
        if ((yield* deterministicTreeHash(path)) !== observedHash) return yield* new PlanIsStale();
      const adoption = { path: selection.sourcePath, equalPaths, observedHash };
      let subjectId: string;
      if (request.kind === "existing") subjectId = request.subjectId;
      else {
        const targets = (request.custody?.harnesses ?? []).map((harness) => ({
          path: selection.sourcePath,
          harness,
          scope: { kind: "global" as const },
        }));
        const plan = yield* planLocalAdoption(targets, selection.sourcePath);
        if (
          plan.targets.some((target) => target.status === "adoptable") &&
          !request.custody?.machineId
        )
          return yield* new LocalAdoptionInvalid({
            name: selection.name,
            reason: "machine-identity-required",
          });
        if (!plan.applicable || !plan.sourcePath || !plan.skill)
          return yield* new LocalAdoptionInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        const refreshed = yield* planLocalAdoption(plan.targets, plan.sourcePath);
        if (localAdoptionPlanIdentity(refreshed) !== localAdoptionPlanIdentity(plan))
          return yield* new PlanIsStale();
        const retained = yield* retainLibrarySource(plan.sourcePath);
        if (retained.collection_id === undefined)
          return yield* new LocalAdoptionInvalid({
            name: selection.name,
            reason: "source-not-candidate",
          });
        subjectId = retained.collection_id;
        adoption.path = plan.sourcePath;
        adoption.observedHash = plan.skill.validationDigest;
      }
      return yield* bindCopy(bindings, selection, subjectId, adoption, retirement);
    }, withLibraryWriter),
  };
});

/** Capture duplicate preservation before adoption or binding. */
const prepareDuplicatePreservation = Effect.fn("LocalAdoption.prepareDuplicatePreservation")(
  function* (
    roots: InventoryRootOptions,
    selection: Effect.Success<ReturnType<typeof approveLocalAdoption>>,
    operationDirectory?: string,
  ) {
    if (selection.duplicateAction === "preserve-duplicates") {
      const shadows = yield* observeHarnessShadows(roots, { kind: "global" }, [selection.name]);
      const copies = yield* captureSetupCopies(
        selection.sourcePath,
        shadows,
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
              yield* captureSetupCopies(selection.sourcePath, shadows, copies);
              yield* moves.apply();
            }),
        },
        aliases: [] as readonly SetupApprovedAlias[],
        harnesses: [...new Set(shadows.map((shadow) => shadow.harness).filter(hasHarnessProfile))],
      };
    }
    if (selection.duplicateAction !== "retire-aliases") return undefined;
    const approvedAliases: readonly SetupApprovedAlias[] = selection.approvedAliases;
    const shadows = yield* observeHarnessShadows(roots, { kind: "global" }, [selection.name]);
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
      shadows,
      approvedAliases,
      destinations,
      operationDirectory,
    );
  },
);

/** Bind before preserving any displaced entry, using approval captured before adoption. */
const bindCopy = Effect.fn("LocalAdoption.bindCopy")(function* (
  roots: InventoryRootOptions,
  selection: SetupCopySelection,
  subjectId: string,
  adoption: NonNullable<BindingChangeRequest["adoption"]>,
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
              allowedShadowAliases: retirement.aliases.map((entry) => ({
                ...entry,
                canonicalPath: selection.sourcePath,
              })),
            }
          : {}),
        selectedSkills: [selection.name],
        scope: { kind: "global" },
        enabled: true,
        adoption,
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
export const captureLocalAdoptionAliases = Effect.fn("LocalAdoption.captureAliasApproval")(
  function* (
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
        yield* leavePnpmSkill(path);
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
  },
);

const planAliasRetirement = Effect.fn("LocalAdoption.planAliasRetirement")(function* (
  libraryHome: string,
  name: string,
  sourcePath: string,
  shadows: readonly HarnessShadow[],
  approvedAliases: readonly SetupApprovedAlias[] | undefined,
  destinations: readonly string[],
  operationDirectory?: string,
) {
  const aliases = yield* captureLocalAdoptionAliases(sourcePath, shadows, approvedAliases);
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
  const harnesses = [...new Set(shadows.map((shadow) => shadow.harness).filter(hasHarnessProfile))];
  return { moves, aliases, harnesses };
});

/** Existing entries stay active until every affected reader has a verified replacement. */
const preserveAfterInstalledSkill = Effect.fn("LocalAdoption.preserveCopiesAfterInstall")(
  function* (
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
        (projection) =>
          projection.skill_id === skill?.skill_id && projection.status === "installed",
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
      const custody = projection ? yield* installedSkillCustody(projection) : undefined;
      if (
        !projection ||
        custody?.kind !== "intact" ||
        custody.observed !== projection.expected_digest ||
        custody.marker.expected_digest !== projection.expected_digest ||
        custody.marker.skill_version_id !== projection.skill_version_id ||
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
  },
);
