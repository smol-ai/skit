// Setup's Manage and Update steps. Each routes by the routing recorded in its step, never by this
// machine's configuration, so a re-run after a crash installs exactly where the first run did.

import { Effect, FileSystem, Option, Schema } from "effect";
import { Digest } from "effect/crypto";
import { dirname, join, resolve } from "node:path";
import { digestTreeHash } from "../artifact/skit.js";
import { TreeHasher } from "../artifact/tree-hasher.js";
import { hasHarnessProfile } from "../harnesses/catalog.js";
import { inspectInstalledSkill } from "../install/files.js";
import { LinkStat } from "../platform/link-stat.js";
import { InstallScope } from "../vocabulary.js";
import { apply } from "./apply-plan.js";
import { findDuplicates, type DuplicateScanError } from "./duplicates.js";
import { InvalidIntent } from "./enabled-plan.js";
import type { CollectionId, OperationId } from "./entity-ids.js";
import { absentUnder, holdsEvidence, parentIsAsRecorded } from "./folder-evidence.js";
import { importCollection } from "./import-collection.js";
import { InstalledSkills } from "./installed-skills.js";
import {
  ReviewedChangeDiffers,
  updateInstalledSkills,
  type ReviewedChange,
} from "./installed-update.js";
import type { AppliedChange } from "./library-plan.js";
import { incompleteManageWarning, planManage } from "./manage-plan.js";
import { planIntent } from "./plan-changes.js";
import { moveAside, recoveryDirectory } from "./setup-moves.js";
import { LibraryStore } from "./store/library-store.js";
import type {
  FolderEvidence,
  LinkEvidence,
  ManageExistingSelection,
  ManageNewSelection,
  RecordedSetupStep,
  ReviewedInstalledSkillChange,
  SetupStep,
  SetupStopReason,
  StepEvidence,
  StepRouting,
} from "./store/state-schema.js";
import { resolveLibrarySubject } from "./subject-resolution.js";

/** What a Manage step did: each enable it applied, its warnings and where it moved duplicates. */
export interface ManageResult {
  readonly _tag: "Manage";
  readonly results: readonly AppliedChange[];
  readonly warnings: readonly { readonly name: string; readonly message: string }[];
  readonly recoveryDirectories: readonly string[];
}

export type ManagedStep =
  | { readonly _tag: "Ran"; readonly result: ManageResult; readonly after: readonly StepEvidence[] }
  | { readonly _tag: "Stop"; readonly reason: SetupStopReason };

type ManageStep = Extract<SetupStep, { readonly _tag: "Manage" }>;
type UpdateStep = Extract<SetupStep, { readonly _tag: "Update" }>;

const sameScope = Schema.toEquivalence(InstallScope);
const destinationsIn = (routing: StepRouting, scope: InstallScope) =>
  routing.destinations
    .filter((target) => sameScope(target.scope, scope))
    .map(({ destination, root }) => ({ destination, root }));
const readableIn = (routing: StepRouting, scope: InstallScope) =>
  routing.readable
    .filter((root) => sameScope(root.scope, scope))
    .map(({ harness, root }) => ({ harness, root }));
const global: InstallScope = { kind: "global" };

/** The tree hash over Digest, so setup needs no TreeHasher service. */
const digestTreeHasher = Effect.map(Digest.Digest, (digest) => ({
  hash: (path: string) => digestTreeHash(path).pipe(Effect.provideService(Digest.Digest, digest)),
}));

/** This device's skill folders, routed only by what the step recorded. */
export const routedInstalledSkills = Effect.fn("Library.setup.routedInstalledSkills")(function* (
  routing: StepRouting,
) {
  const context = yield* Effect.context<FileSystem.FileSystem | LinkStat | Digest.Digest>();
  const hasher = yield* digestTreeHasher;
  return yield* InstalledSkills.make({
    active: Effect.succeed(routing.active),
    destinations: (scope) => Effect.succeed(destinationsIn(routing, scope)),
    duplicates: {
      scan: (scope, names) =>
        Effect.gen(function* () {
          const warnings: DuplicateScanError[] = [];
          const readable = readableIn(routing, scope);
          const copies = names.length
            ? yield* findDuplicates(
                { destinations: destinationsIn(routing, scope), readable },
                names,
                warnings,
              )
            : [];
          return { copies, warnings, roots: readable.map(({ root }) => root) };
        }).pipe(Effect.provide(context)),
    },
  }).pipe(Effect.provideService(TreeHasher, hasher));
});

const differs = (step: number, evidence: FolderEvidence | LinkEvidence): ManagedStep => ({
  _tag: "Stop",
  reason: {
    _tag: "EvidenceDiffers",
    step,
    path: evidence.path,
    expected: { before: Option.some(evidence), after: Option.none() },
  },
});

/**
 * What an earlier run of this step left at a folder it manages, checked on the folder itself:
 * - "reviewed": as reviewed, with no marker. Also what is left when the Library recorded the
 *   copy but stopped before writing SKIT's marker; enabling again writes it.
 * - "recording": the reviewed folder holds SKIT's marker for a copy the Library still records as
 *   pending; enabling again records it installed.
 * - "managed": the reviewed folder is SKIT's installed copy.
 * - "differs": anything else.
 * "The reviewed folder" means the same parent and file, and the reviewed bytes.
 */
const reviewedOrManaged = Effect.fn("Library.setup.reviewedOrManaged")(function* (
  evidence: FolderEvidence,
) {
  const state = yield* (yield* LibraryStore).load;
  if (!(yield* parentIsAsRecorded(evidence.path, evidence.parent))) return "differs" as const;
  if (yield* holdsEvidence(evidence, evidence.path)) return "reviewed" as const;
  const recorded = state.installed_skills.find(
    (copy) =>
      copy.path === evidence.path && (copy.status === "installed" || copy.status === "pending"),
  );
  if (recorded === undefined) return "differs" as const;
  const links = yield* LinkStat;
  const info = yield* links.identity.lstat(evidence.path).pipe(Effect.option);
  if (
    Option.isNone(info) ||
    info.value.type !== "Directory" ||
    info.value.dev !== evidence.dev ||
    info.value.ino !== evidence.ino
  )
    return "differs" as const;
  const ownership = yield* inspectInstalledSkill(recorded).pipe(
    Effect.provideService(TreeHasher, yield* digestTreeHasher),
  );
  if (
    ownership.kind !== "intact" ||
    ownership.marker.installed_skill_id !== recorded.installed_skill_id ||
    ownership.currentHash !== evidence.treeHash
  )
    return "differs" as const;
  return recorded.status === "installed" ? ("managed" as const) : ("recording" as const);
});

/** The duplicates a policy moves aside: approved links not at a destination, or approved copies. */
export const duplicatesToMove = (
  routing: StepRouting,
  selection: ManageExistingSelection | ManageNewSelection,
): readonly (FolderEvidence | LinkEvidence)[] => {
  const policy = Option.getOrUndefined(selection.duplicates);
  if (policy === "preserve-duplicates") return selection.approvedCopies;
  if (policy !== "retire-aliases") return [];
  const destinations = destinationsIn(routing, global)
    .filter(({ destination }) => routing.active.includes(destination))
    .map(({ root }) => join(root, selection.name));
  return selection.approvedSymlinks.filter((link) => !destinations.includes(link.path));
};

/** Enable the subject's `name` globally, managing the reviewed folder in place where it is one. */
const enable = Effect.fn("Library.setup.enable")(function* (
  selection: ManageExistingSelection | ManageNewSelection,
  subjectId: string,
  manage: {
    readonly path: string;
    readonly equalPaths: readonly string[];
    readonly currentHash: string;
  },
) {
  const state = yield* (yield* LibraryStore).load;
  const resolved = yield* resolveLibrarySubject(state, subjectId);
  const subject =
    resolved.kind === "collection"
      ? { _tag: "Collection" as const, id: resolved.collection.collection_id }
      : { _tag: "Skill" as const, id: resolved.skill.skill_id };
  const policy = Option.getOrUndefined(selection.duplicates);
  const plan = yield* planIntent(
    {
      _tag: "Enabled",
      changes: [
        {
          _tag: "Enable",
          subject,
          members: state.skills
            .filter(
              (skill) =>
                skill.name === selection.name &&
                (subject._tag === "Collection"
                  ? skill.collection_id === subject.id
                  : skill.skill_id === subject.id),
            )
            .map((skill) => skill.skill_id),
          where: [global],
          allowDuplicate: policy === "keep-both" || policy === "preserve-duplicates",
          setup: {
            approvedSymlinks: selection.approvedSymlinks.map((link) => ({
              path: link.path,
              canonicalPath: link.canonicalPath,
              dev: String(link.dev),
              ino: String(link.ino),
              linkTarget: link.linkTarget,
            })),
          },
        },
      ],
    },
    {
      base: state,
      approvals: [
        {
          _tag: "Manage",
          manage: {
            path: manage.path,
            equalPaths: [...manage.equalPaths],
            currentHash: manage.currentHash,
          },
        },
      ],
    },
  );
  const outcome = yield* apply(plan);
  if (outcome._tag === "Applied") return { results: outcome.results, warnings: [] };
  // Setup keeps the managed copy while other differing copies stay where agents read them.
  const warning = incompleteManageWarning(selection.name, {
    reason: outcome.reason,
    message: outcome.cause.message,
  });
  if (Option.isNone(warning)) return yield* Effect.fail(outcome.cause);
  return { results: outcome.results, warnings: [warning.value] };
});

/**
 * Why the duplicates of `name` must stay where they are: a destination an agent that read them
 * reads does not hold SKIT's intact copy yet. None when every one does.
 */
const replacementMissing = Effect.fn("Library.setup.replacementMissing")(function* (
  routing: StepRouting,
  subjectId: string,
  name: string,
  moving: readonly (FolderEvidence | LinkEvidence)[],
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const state = yield* (yield* LibraryStore).load;
  const subject = yield* resolveLibrarySubject(state, subjectId);
  const skill = subject.skills.find((item) => item.name === name);
  const canonical = (path: string) =>
    fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
  const readable = readableIn(routing, global);
  const parents = yield* Effect.forEach(moving, ({ path }) => canonical(dirname(path)));
  const harnesses = new Set<string>();
  for (const root of readable)
    if (parents.includes(yield* canonical(root.root)) && hasHarnessProfile(root.harness))
      harnesses.add(root.harness);
  const readableRoots = yield* Effect.forEach(
    readable.filter((root) => harnesses.has(root.harness)),
    (root) => canonical(root.root),
  );
  let required = 0;
  for (const target of destinationsIn(routing, global)) {
    if (!routing.active.includes(target.destination)) continue;
    if (!readableRoots.includes(yield* canonical(target.root))) continue;
    required++;
    const path = join(target.root, name);
    const expectedPath = yield* canonical(path);
    const candidates = state.installed_skills.filter(
      (copy) => copy.skill_id === skill?.skill_id && copy.status === "installed",
    );
    const installedPaths = yield* Effect.forEach(candidates, (copy) => canonical(copy.path));
    if (!(yield* fs.exists(join(path, "SKILL.md"))) || !installedPaths.includes(expectedPath))
      return Option.some(
        `Bound ${name}; existing copies were left in place because the replacement at ${path} is not installed. Run skit doctor to inspect the conflict.`,
      );
    const installed = candidates.find((candidate) => candidate.path === path);
    const ownership = installed
      ? yield* inspectInstalledSkill(installed).pipe(
          Effect.provideService(TreeHasher, yield* digestTreeHasher),
        )
      : undefined;
    if (
      !installed ||
      ownership?.kind !== "intact" ||
      ownership.currentHash !== installed.expected_hash ||
      ownership.marker.expected_hash !== installed.expected_hash ||
      ownership.marker.skill_version_id !== installed.skill_version_id ||
      (yield* links.lstat(path)).type !== "Directory"
    )
      return Option.some(
        `Bound ${name}; existing copies remain because the replacement at ${path} changed before preservation.`,
      );
  }
  if (!required)
    return Option.some(
      `Bound ${name}; existing copies were left in place because no active replacement is readable by their harness. Run skit doctor to inspect the conflict.`,
    );
  return Option.none<string>();
});

/** The Collection that the Import step `step` saved, as its Done write recorded it. */
const importedCollection = Effect.fn("Library.setup.importedCollection")(function* (
  steps: readonly RecordedSetupStep[],
  step: number,
) {
  const [collectionId] = (steps[step]?.after ?? []).flatMap((evidence) =>
    evidence._tag === "Retained" ? [evidence.collectionId] : [],
  );
  if (collectionId === undefined)
    return yield* new InvalidIntent({ detail: `Setup step ${step + 1} imported no Collection` });
  return collectionId;
});

/** The Collection a "new" selection's files are in, importing them where the step says to. */
const sourceCollection = Effect.fn("Library.setup.sourceCollection")(function* (
  selection: ManageNewSelection,
  steps: readonly RecordedSetupStep[],
) {
  switch (selection.importFrom._tag) {
    case "Import":
      return (yield* Effect.scoped(importCollection(selection.importFrom.request))).collection
        .collection_id;
    case "Collection":
      return selection.importFrom.collectionId;
    case "Step":
      return yield* importedCollection(steps, selection.importFrom.step);
  }
});

/**
 * Manage each selection: check the folder is still as reviewed (or already managed by an earlier
 * run of this step), enable it, then move its approved duplicates aside once every agent that read
 * them can read SKIT's copy. Safe to repeat.
 */
export const runManage = Effect.fn("Library.setup.manage")(function* (
  operationId: OperationId,
  index: number,
  step: ManageStep,
  steps: readonly RecordedSetupStep[],
) {
  const store = yield* LibraryStore;
  const files = yield* routedInstalledSkills(step.routing);
  const results: AppliedChange[] = [];
  const warnings: { readonly name: string; readonly message: string }[] = [];
  const recoveryDirectories: string[] = [];
  const after: StepEvidence[] = [];
  const selections: readonly (ManageExistingSelection | ManageNewSelection)[] = step.selections;
  for (const [at, selection] of selections.entries()) {
    const policy = Option.getOrUndefined(selection.duplicates);
    let subjectId: string;
    let manage: { path: string; equalPaths: readonly string[]; currentHash: string };
    if (selection.mode === "existing") {
      if (policy === "retain-only") continue;
      subjectId = selection.subjectId;
      manage = { path: selection.source.path, equalPaths: [], currentHash: selection.currentHash };
    } else {
      const collectionId: CollectionId = yield* sourceCollection(selection, steps);
      if (policy === "retain-only" || Option.isNone(selection.ownership)) continue;
      subjectId = collectionId;
      for (const copy of selection.equalCopies)
        if ((yield* reviewedOrManaged(copy)) === "differs") return differs(index, copy);
      manage = {
        path: selection.source.path,
        equalPaths: selection.equalCopies.map(({ path }) => path),
        currentHash: selection.source.treeHash,
      };
    }
    const source = yield* reviewedOrManaged(selection.source);
    if (source === "differs") return differs(index, selection.source);
    const moving = duplicatesToMove(step.routing, selection);
    for (const folder of moving)
      if (
        !(yield* absentUnder(folder.path, folder.parent)) &&
        !(
          (yield* parentIsAsRecorded(folder.path, folder.parent)) &&
          (yield* holdsEvidence(folder, folder.path))
        )
      )
        return differs(index, folder);
    if (source !== "managed") {
      if (source === "reviewed" && selection.mode === "new" && Option.isSome(selection.ownership)) {
        const ownership = selection.ownership.value;
        const plan = yield* planManage(
          ownership.harnesses.map((harness) => ({
            path: selection.source.path,
            harness,
            scope: global,
          })),
          selection.source.path,
        );
        if (
          plan.targets.some((target) => target.status === "adoptable") &&
          Option.isNone(ownership.machineId)
        )
          return yield* new InvalidIntent({
            detail: `Managing ${selection.name} needs this machine's identity`,
          });
        if (!plan.applicable || plan.sourcePath === undefined || plan.skill === undefined)
          return yield* new InvalidIntent({
            detail: `${selection.name} cannot be managed as it is`,
          });
        manage = { ...manage, path: plan.sourcePath, currentHash: plan.skill.validationHash };
      }
      const enabled = yield* enable(selection, subjectId, manage).pipe(
        Effect.provideService(InstalledSkills.Service, files),
      );
      results.push(...enabled.results);
      warnings.push(...enabled.warnings);
    }
    if (!moving.length) continue;
    const missing = yield* replacementMissing(step.routing, subjectId, selection.name, moving);
    if (Option.isSome(missing)) {
      warnings.push({ name: selection.name, message: missing.value });
      continue;
    }
    const moved = yield* moveAside(
      operationId,
      recoveryDirectory(store.home, operationId, index, at),
      moving,
    );
    if (moved._tag === "Differs") return differs(index, moved.folder);
    recoveryDirectories.push(moved.directory);
    after.push(
      ...moving.map((folder) => ({
        _tag: "Absent" as const,
        path: folder.path,
        parent: folder.parent,
      })),
    );
  }
  return {
    _tag: "Ran",
    result: { _tag: "Manage", results, warnings, recoveryDirectories },
    after,
  } satisfies ManagedStep;
});

/** A reviewed change in the form the Library's review gives it. */
const reviewedChange = (change: ReviewedInstalledSkillChange): ReviewedChange => ({
  ...Option.match(change.installedSkillId, {
    onNone: () => ({}),
    onSome: (installedSkillId) => ({ installedSkillId }),
  }),
  ...Option.match(change.baselineHash, {
    onNone: () => ({}),
    onSome: (baselineHash) => ({ baselineHash }),
  }),
  skillId: change.skillId,
  name: change.name,
  path: change.path,
  destination: change.destination,
  ...Option.match(change.currentHash, {
    onNone: () => ({}),
    onSome: (currentHash) => ({ currentHash }),
  }),
  ...Option.match(change.desiredHash, {
    onNone: () => ({}),
    onSome: (desiredHash) => ({ desiredHash }),
  }),
  ...Option.match(change.desiredVersionId, {
    onNone: () => ({}),
    onSome: (desiredVersionId) => ({ desiredVersionId }),
  }),
  evidence: change.evidence,
  status: change.status,
  metadataChanged: change.metadataChanged,
});

/**
 * Update the reviewed copies, routed as recorded. A copy an earlier run already updated no longer
 * writes and is accepted; anything that writes other than as reviewed stops the operation.
 */
export const runUpdate = Effect.fn("Library.setup.update")(function* (
  index: number,
  step: UpdateStep,
) {
  const files = yield* routedInstalledSkills(step.routing);
  return yield* updateInstalledSkills(
    step.changes.map(reviewedChange),
    step.versionChoices.map((choice) => ({
      skillId: choice.skillId,
      version: choice.version,
      ...Option.match(choice.path, { onNone: () => ({}), onSome: (path) => ({ path }) }),
    })),
    step.importedAt,
  ).pipe(
    Effect.provideService(InstalledSkills.Service, files),
    Effect.map((changes) => ({
      _tag: "Ran" as const,
      result: { _tag: "Update" as const, changes },
      after: [],
    })),
    Effect.catchTag("Library.ReviewedChangeDiffers", (error: ReviewedChangeDiffers) =>
      Effect.succeed({
        _tag: "Stop" as const,
        reason: {
          _tag: "EvidenceDiffers" as const,
          step: index,
          path: error.path,
          expected: { before: Option.none(), after: Option.none() },
        },
      }),
    ),
  );
});
