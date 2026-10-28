import { basename, dirname, join, relative, resolve } from "node:path";
import { Effect, FileSystem } from "effect";
import {
  canonicalJson,
  copyLocalTree,
  globalEnabled,
  inspectOwnershipMarker,
  inspectInstalledSkillBackups,
  LibraryStore,
  LinkStat,
  pathIsWithin,
  prepareInstalledSkillRebuild,
  collectionVersionPath,
  versionBacking,
  writeRawAtomic,
  type LibraryState,
  type InstalledSkill,
} from "@smolai/skit-core";
import { PlanIsStale } from "../library/failures.js";
import { inspectSetupOperation, captureSetupFile } from "./setup-operation.js";
import { inspectRecoveryOperation, prepareOwnedRecoveryMoves } from "./recovery-moves.js";
import { checkSetupGlobalContent } from "./setup-external-ownership.js";
import { recoveryFingerprint, RecoveryInvalid } from "./recovery-evidence.js";

type Operation = Effect.Success<ReturnType<typeof inspectSetupOperation>>["operation"];
type File = Operation["files"][number];
type CapturedFile = Effect.Success<ReturnType<typeof captureSetupFile>>;

/** Scan timestamps are evidence, not a change to desired installed-skill ownership. */
export const installedSkillChoice = (installedSkill: InstalledSkill | undefined) =>
  installedSkill === undefined
    ? null
    : {
        installed_skill_id: installedSkill.installed_skill_id,
        skill_id: installedSkill.skill_id,
        skill_version_id: installedSkill.skill_version_id,
        path: installedSkill.path,
        root: installedSkill.root,
        target: installedSkill.destination,
        expected_digest: installedSkill.expected_digest,
        status: installedSkill.status,
        suppressed_at: installedSkill.suppressed_at,
      };
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

/** Check the original namespace anchor, even when today's nearest existing parent has changed. */
const checkAnchor = Effect.fn("SetupUndo.checkAnchor")(function* (file: File) {
  const links = yield* LinkStat;
  const physical = yield* links.realPathNative(file.anchor.path);
  const anchor = yield* links.identity.lstat(physical);
  if (
    physical !== file.anchor.physicalPath ||
    anchor.dev !== file.anchor.dev ||
    anchor.ino !== file.anchor.ino
  )
    return yield* new RecoveryInvalid({ detail: `Redirected original parent: ${file.path}` });
  const suffix = relative(file.anchor.path, dirname(file.path));
  const expected = resolve(file.anchor.physicalPath, suffix);
  // A present parent must still name the same physical namespace. Missing parents are allowed
  // only for an originally absent entry, which undo never recreates.
  const parent = yield* links
    .realPathNative(dirname(file.path))
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (
    (parent !== undefined && parent !== expected) ||
    (file.entry !== null && parent === undefined)
  )
    return yield* new RecoveryInvalid({
      detail: `Redirected or missing original parent: ${file.path}`,
    });
});

const restoreMarker = Effect.fn("SetupUndo.restoreMarker")(function* (
  path: string,
  entry: NonNullable<File["entry"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const marker = join(path, ".skit-ownership.json");
  const existing = yield* links
    .lstat(marker)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  if (existing && existing.type !== "File")
    return yield* new RecoveryInvalid({ detail: `Unsafe ownership marker at ${path}` });
  if (entry.marker === null) {
    if (existing) yield* fs.remove(marker).pipe(Effect.uninterruptible);
  } else {
    if (entry.markerType !== "File" || entry.markerMode === undefined || entry.markerMode === null)
      return yield* new RecoveryInvalid({
        detail: `Original marker metadata unavailable at ${path}`,
      });
    yield* writeRawAtomic(marker, entry.marker, false, entry.markerMode & 0o7777);
    yield* fs.chmod(marker, entry.markerMode & 0o7777);
  }
});

/** File effects are prepared from immutable before evidence, never inferred from desired bindings. */
export const prepareSetupUndoFiles = Effect.fn("SetupUndo.prepareFiles")(function* (
  operationId: string,
  operation: Operation,
  expected: readonly InstalledSkill[],
  state: LibraryState,
  preservationDirectory: string,
  priorPreservations: readonly string[],
  restoredState: LibraryState,
  confirmedInstalledSkillPaths: ReadonlySet<string>,
) {
  const store = yield* LibraryStore;
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const recovery = yield* inspectRecoveryOperation(store.home, operationId);
  const preserved = yield* Effect.forEach(priorPreservations, (id) =>
    inspectRecoveryOperation(store.home, id),
  );
  const conflicts: string[] = [];
  const observations: CapturedFile[] = [];
  const actions: {
    path: string;
    kind: "release-ownership" | "restore" | "remove-created";
    source?: string;
    transfer?: "move" | "copy" | "rebuild";
  }[] = [];
  const moves: { name: string; installedSkill: InstalledSkill }[] = [];
  const rebuilds = new Map<
    string,
    Effect.Success<ReturnType<typeof prepareInstalledSkillRebuild>>
  >();
  const affected = new Set<string>();
  const physicalPaths: string[] = [];
  const physicalHome = yield* links.realPathNative(store.home);
  for (const file of operation.files) {
    const prior = operation.installedSkills.find((item) => resolve(item.path) === file.path);
    const after = expected.find((item) => resolve(item.path) === file.path);
    const current = state.installed_skills.find((item) => resolve(item.path) === file.path);
    const saved = recovery.entries.filter((entry) => entry.path === file.path);
    const observed = yield* captureSetupFile(file.path);
    observations.push(observed);
    const changedInstalledSkill = !equal(installedSkillChoice(prior), installedSkillChoice(after));
    const possibleClaim =
      observed.entry?.marker !== file.entry?.marker &&
      after?.status === "installed" &&
      (file.entry === null || file.entry.marker === null);
    const approvedPath =
      operation.installedSkillPaths === undefined ||
      operation.installedSkillPaths.includes(file.path);
    const claim = possibleClaim && approvedPath && confirmedInstalledSkillPaths.has(file.path);
    if (!saved.length && !changedInstalledSkill && possibleClaim && approvedPath && !claim) {
      conflicts.push(`Setup's ownership claim is not confirmed: ${file.path}`);
      continue;
    }
    if (!saved.length && !claim && !changedInstalledSkill) continue;
    if ((yield* Effect.result(checkSetupGlobalContent(file.path)))._tag === "Failure") {
      conflicts.push(
        `Repository, authored or package-manager ownership protects this path: ${file.path}`,
      );
      continue;
    }
    affected.add(file.path);
    if (
      file.entry?.type === "Directory" &&
      file.entry.marker === null &&
      file.entry.hash !== file.entry.unstampedHash
    ) {
      conflicts.push(`Original ownership marker is not reproducible: ${file.path}`);
      continue;
    }
    const anchor = yield* Effect.result(checkAnchor(file));
    if (anchor._tag === "Failure") {
      conflicts.push(`Original parent changed: ${file.path}`);
      continue;
    }
    const physical = join(observed.anchor.physicalPath, relative(observed.anchor.path, file.path));
    if (
      physical === physicalHome ||
      pathIsWithin(physicalHome, physical) ||
      pathIsWithin(physical, physicalHome)
    ) {
      conflicts.push(`Library storage cannot be restored over: ${file.path}`);
      continue;
    }
    if (
      physicalPaths.some(
        (other) =>
          other === physical || pathIsWithin(other, physical) || pathIsWithin(physical, other),
      )
    ) {
      conflicts.push(`Overlapping original paths: ${file.path}`);
      continue;
    }
    physicalPaths.push(physical);
    if (
      !equal(installedSkillChoice(current), installedSkillChoice(after)) &&
      !equal(installedSkillChoice(current), installedSkillChoice(prior))
    ) {
      conflicts.push(`Installed-skill choice changed: ${file.path}`);
      continue;
    }
    if (
      observed.entry?.hash === file.entry?.hash &&
      (observed.entry !== null) === (file.entry !== null)
    )
      continue;
    const marker =
      observed.entry?.markerType === "File" ? yield* inspectOwnershipMarker(file.path) : undefined;
    const owned =
      current &&
      after &&
      equal(installedSkillChoice(current), installedSkillChoice(after)) &&
      marker?.kind === "valid" &&
      marker.marker.installed_skill_id === current.installed_skill_id &&
      marker.marker.skill_id === current.skill_id &&
      marker.marker.skill_version_id === current.skill_version_id &&
      marker.marker.expected_digest === current.expected_digest;
    if (
      file.entry &&
      observed.entry &&
      owned &&
      observed.entry.dev === file.entry.dev &&
      observed.entry.ino === file.entry.ino &&
      observed.entry.unstampedHash === file.entry.unstampedHash
    ) {
      actions.push({ path: file.path, kind: "release-ownership" });
      continue;
    }
    if (
      file.entry &&
      observed.entry &&
      observed.entry.dev === file.entry.dev &&
      observed.entry.ino === file.entry.ino &&
      observed.entry.unstampedHash !== file.entry.unstampedHash
    ) {
      conflicts.push(`Managed original was edited: ${file.path}`);
      continue;
    }
    if (observed.entry && !owned) {
      conflicts.push(`Occupied original path: ${file.path}`);
      continue;
    }
    if (observed.entry && owned) moves.push({ name: basename(file.path), installedSkill: current });
    if (file.entry === null) {
      if (observed.entry) actions.push({ path: file.path, kind: "remove-created" });
      continue;
    }
    // Missing a setup-created successor is not permission to reverse a newer user deletion.
    if (
      !observed.entry &&
      after &&
      !saved.some((entry) => entry.status === "saved") &&
      !preserved.some((inspection) =>
        inspection.entries.some((entry) => entry.path === file.path && entry.status === "saved"),
      )
    ) {
      conflicts.push(`Installed copy disappeared without undo preservation: ${file.path}`);
      continue;
    }
    let source: string | undefined;
    // File recovery calls an occupied destination a conflict. Full undo can first
    // preserve its owned successor, so validate the saved original independently.
    for (const entry of saved) {
      const evidence = yield* captureSetupFile(entry.recoveryPath);
      if (
        evidence.entry?.hash === file.entry.hash &&
        evidence.entry.dev === file.entry.dev &&
        evidence.entry.ino === file.entry.ino
      )
        source = entry.recoveryPath;
    }
    for (const installedSkill of [prior, after]) {
      if (source !== undefined || installedSkill === undefined) continue;
      for (const path of yield* inspectInstalledSkillBackups(installedSkill)) {
        const evidence = yield* captureSetupFile(path);
        if (
          evidence.entry?.hash === file.entry.hash &&
          evidence.entry.dev === file.entry.dev &&
          evidence.entry.ino === file.entry.ino
        )
          source = path;
      }
    }
    // Reconstruction copies immutable retained bytes; it never moves or edits their source.
    if (source === undefined && file.entry.type === "Directory") {
      for (const skill of state.skills)
        for (const version of skill.versions) {
          const backing = versionBacking(state, skill, version);
          if (!backing) continue;
          const root = collectionVersionPath(store.originalsPath, backing.copy.digest);
          const path =
            backing.member.source_path === "." ? root : join(root, backing.member.source_path);
          const evidence = yield* Effect.result(captureSetupFile(path));
          if (
            evidence._tag === "Success" &&
            evidence.success.entry?.unstampedHash === file.entry.unstampedHash
          )
            source = path;
        }
    }
    if (source === undefined && prior && file.entry.markerType === "File") {
      const policy = globalEnabled(restoredState).invocation_policies?.[prior.skill_id];
      const rebuilt = yield* Effect.result(
        prepareInstalledSkillRebuild(
          restoredState,
          store.originalsPath,
          prior,
          policy === undefined ? { source: "declared" } : { source: "override", policy },
        ),
      );
      if (rebuilt._tag === "Success") {
        rebuilds.set(file.path, rebuilt.success);
        actions.push({
          path: file.path,
          kind: "restore",
          source: rebuilt.success.collectionVersionPath,
          transfer: "rebuild",
        });
        continue;
      }
    }
    if (source === undefined) {
      conflicts.push(`Original bytes unavailable: ${file.path}`);
      continue;
    }
    const original = (yield* captureSetupFile(source)).entry;
    const transfer =
      original?.dev === file.entry.dev && original?.ino === file.entry.ino ? "move" : "copy";
    if (
      transfer === "move" &&
      (yield* links.identity.lstat(yield* links.realPathNative(dirname(file.path)))).dev !==
        original!.dev
    ) {
      conflicts.push(`Original cannot be renamed across devices: ${file.path}`);
      continue;
    }
    actions.push({ path: file.path, kind: "restore", source, transfer });
  }
  const preservation = yield* prepareOwnedRecoveryMoves(moves, preservationDirectory);
  const sourceEvidence = yield* Effect.forEach(
    actions.filter((action) => action.source !== undefined),
    (action) => captureSetupFile(action.source!),
  );
  return {
    conflicts,
    observations,
    actions,
    affected: [...affected],
    sourceEvidence,
    apply: Effect.fn("SetupUndo.applyFiles")(function* () {
      // Stage and verify every reconstruction before displacing the first live successor.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const staged = new Map<string, string>();
          for (const action of actions) {
            const file = operation.files.find((item) => item.path === action.path)!;
            yield* checkSetupGlobalContent(file.path);
            yield* checkAnchor(file);
            if (action.kind !== "restore" || action.source === undefined || file.entry === null)
              continue;
            if (action.transfer === "move") continue;
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: dirname(file.path),
              prefix: ".skit-undo-",
            });
            const path = join(directory, basename(file.path));
            if (action.transfer === "rebuild") yield* rebuilds.get(file.path)!.build(path);
            else yield* copyLocalTree(action.source, path, undefined, true);
            if (file.entry.type === "Directory") yield* restoreMarker(path, file.entry);
            if ((yield* recoveryFingerprint(path)) !== file.entry.hash)
              return yield* new RecoveryInvalid({
                detail: `Reconstruction differs from original: ${file.path}`,
              });
            staged.set(file.path, path);
          }
          yield* preservation.apply();
          for (const action of actions) {
            const file = operation.files.find((item) => item.path === action.path)!;
            yield* checkSetupGlobalContent(file.path);
            yield* checkAnchor(file);
            if (action.kind === "release-ownership") {
              const before = observations.find((item) => item.path === file.path)!;
              if (!equal(yield* captureSetupFile(file.path), before))
                return yield* new PlanIsStale();
              yield* restoreMarker(file.path, file.entry!);
            } else if (action.kind === "restore") {
              if ((yield* captureSetupFile(file.path)).entry !== null)
                return yield* new PlanIsStale();
              if (
                action.transfer === "move" &&
                !equal(
                  yield* captureSetupFile(action.source!),
                  sourceEvidence.find((entry) => entry.path === action.source),
                )
              )
                return yield* new PlanIsStale();
              yield* fs
                .rename(
                  action.transfer === "move" ? action.source! : staged.get(file.path)!,
                  file.path,
                )
                .pipe(Effect.uninterruptible);
            }
            const actual = (yield* captureSetupFile(file.path)).entry;
            if (file.entry === null ? actual !== null : actual?.hash !== file.entry.hash)
              return yield* new RecoveryInvalid({
                detail: `Original restoration incomplete: ${file.path}`,
              });
          }
        }),
      );
    }),
  };
});
