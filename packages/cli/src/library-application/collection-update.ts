import {
  enabledByScope,
  enabledSkillIds,
  withLibraryWriter,
  LibraryStore,
  type LibraryState,
} from "@smolai/skit-core";
import { Data, Cause, Effect, FileSystem, Predicate } from "effect";
import type { InventoryRootOptions } from "../projection/roots.js";
import { importSource, inspectLibrarySource } from "./import-source.js";
import type { UpdateFailure } from "../workflows/library/update-contract.js";
import { updateInstalledSkills } from "../workflows/library/update-installed-skills.js";
import { LibraryProgress } from "./progress.js";
import {
  latestSourceImport,
  type LibrarySubject,
} from "../workflows/library/subject-resolution.js";
import { dirname, join, resolve } from "node:path";
import { isPlatformError } from "effect/PlatformError";
import { commandFailure } from "../failure-classification.js";
import { sourceLocator } from "@smolai/skit-core";
import { sourceFromUpstream } from "../workflows/library/upstream-source.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class CollectionNotUpdatable
  extends Data.TaggedError("Library.CollectionNotUpdatable")<{
    subject_id: string;
    label: string;
    source?: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message(): string {
    return `${this.label} has no upstream source`;
  }
  get remediation(): string {
    return this.source === undefined
      ? "Add its source again to update it."
      : `Run \`skit add ${this.source}\` to update it.`;
  }
}

const subjectSource = Effect.fn("Library.updateSource")(function* (
  subject: LibrarySubject,
  sourceInput?: string,
) {
  const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
  const resolved = upstream === undefined ? undefined : sourceFromUpstream(upstream);
  if (resolved === undefined)
    return yield* new CollectionNotUpdatable({
      subject_id: subject.subjectId,
      label: subject.label,
      ...(sourceInput === undefined ? {} : { source: sourceInput }),
    });
  return resolved;
});

/**
 * What an update of one Collection means for this device: Skills a followed Collection enables
 * or retires, enabled Skills that changed, individually enabled Skills kept after upstream
 * deleted them, and how many new Skills nothing enables. Unenabled Skills are only counted, so a
 * Source with thousands of Skills stays readable.
 */
const skillChanges = (
  state: LibraryState,
  collectionId: string,
  previous: ReadonlyArray<{ readonly source_path: string; readonly artifact_digest: string }>,
  observed: ReadonlyArray<{
    readonly source_path: string;
    readonly name: string;
    readonly artifact_digest?: string;
  }>,
) => {
  const lists = enabledByScope(state);
  const followed = lists.some((list) =>
    list.enabled.some((item) => "collection" in item && item.collection === collectionId),
  );
  const individual = new Set<string>(
    lists.flatMap((list) => list.enabled.flatMap((item) => ("skill" in item ? [item.skill] : []))),
  );
  const enabled = new Set<string>(lists.flatMap((list) => enabledSkillIds(state, list.enabled)));
  const skillAt = (path: string) =>
    state.skills.find((skill) => skill.collection_id === collectionId && skill.path === path);
  const added = observed.filter(
    (member) => !previous.some((item) => item.source_path === member.source_path),
  );
  const deleted = previous.flatMap((member) => {
    const skill = skillAt(member.source_path);
    return skill === undefined || observed.some((item) => item.source_path === member.source_path)
      ? []
      : [skill];
  });
  return {
    enabled: followed ? added.map((member) => member.name) : [],
    new_available: followed ? 0 : added.length,
    updated: observed.flatMap((member) => {
      const before = previous.find((item) => item.source_path === member.source_path);
      const skill = skillAt(member.source_path);
      return before !== undefined &&
        member.artifact_digest !== undefined &&
        member.artifact_digest !== before.artifact_digest &&
        skill !== undefined &&
        enabled.has(skill.skill_id)
        ? [skill.name]
        : [];
    }),
    removed: deleted
      .filter((skill) => enabled.has(skill.skill_id) && !individual.has(skill.skill_id))
      .map((skill) => skill.name),
    kept: deleted.filter((skill) => individual.has(skill.skill_id)).map((skill) => skill.name),
  };
};

const resolveUpdate = Effect.fn("Library.resolveCollectionUpdate")(function* (
  state: LibraryState,
  subject: LibrarySubject,
) {
  const acquisition = latestSourceImport(state, subject);
  const priorTree =
    acquisition === undefined
      ? undefined
      : state.collection_versions.find(
          (tree) => tree.collection_version_id === acquisition.collection_version_id,
        );
  if (acquisition === undefined || priorTree === undefined)
    return yield* new CollectionNotUpdatable({
      subject_id: subject.subjectId,
      label: subject.label,
    });
  const input = yield* subjectSource(subject, acquisition.input.value);
  return { acquisition, priorTree, input };
});

/** Observe one Collection without retaining content or reconciling installed skills. */
export const previewCollectionUpdate = Effect.fn("Library.previewCollectionUpdate")(function* (
  state: LibraryState,
  subject: LibrarySubject,
) {
  const { acquisition, priorTree: tree, input } = yield* resolveUpdate(state, subject);
  const inspected = yield* inspectLibrarySource(
    input,
    undefined,
    tree.members.map((member) => member.source_path),
  );
  const members = ("members" in inspected ? inspected.members : undefined) ?? [];
  return {
    subject_id: subject.subjectId,
    subject_kind: subject.kind,
    current_snapshot_digest: tree.digest,
    available_snapshot_digest: inspected.snapshot_digest,
    changed: tree.digest !== inspected.snapshot_digest,
    label: subject.label,
    ...("diagnostics" in inspected && inspected.diagnostics?.length
      ? { diagnostics: inspected.diagnostics }
      : {}),
    ...skillChanges(
      state,
      acquisition.collection_id,
      tree.members,
      inspected.skills.map((skill) => ({
        source_path: skill.verbatim_path,
        name: skill.name,
        ...members.find((member) => member.source_path === skill.verbatim_path),
      })),
    ),
  };
});

/** Canonicalize the existing ancestor too, since a failed write's destination may not exist. */
const canonicalStoragePath = Effect.fn("Library.canonicalStoragePath")(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  let path = resolve(input);
  const suffix: string[] = [];
  while (true) {
    const canonical = yield* fs
      .realPath(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (canonical !== undefined) return join(canonical, ...suffix);
    const parent = dirname(path);
    if (parent === path) return resolve(input);
    suffix.unshift(path.slice(parent.length).replace(/^[/\\]/, ""));
    path = parent;
  }
});

/**
 * Own one update through scope cleanup. Recoverable failures report persisted evidence;
 * shared-storage failures, interruption and programming defects remain failures of the action.
 */
export const updateCollection = Effect.fn("Library.updateCollection")(function* (
  state: LibraryState,
  before: LibrarySubject,
  options: { readonly roots: InventoryRootOptions },
) {
  const progress = yield* LibraryProgress;
  const store = yield* LibraryStore;
  const storeHome = yield* canonicalStoragePath(store.home);
  let phase: UpdateFailure["phase"] = "source";
  let source = before.label;
  let sourceRetained = false;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const { priorTree, input } = yield* resolveUpdate(state, before);
      source = sourceLocator(input);
      const subject = { id: before.subjectId, label: before.label };
      const retained = yield* progress.around(
        { kind: "source", subject },
        importSource(
          input,
          undefined,
          priorTree.members.map((member) => member.source_path),
        ),
        (value) => ({
          kind: "source-inspected",
          changed: value.snapshot_digest !== priorTree.digest,
        }),
      );
      sourceRetained = true;
      const changed = retained.snapshot_digest !== priorTree.digest;
      let projected = 0;
      const collectionId =
        before.kind === "collection" ? before.collection.collection_id : before.skill.collection_id;
      // Reconcile even when the Source is current: a previous run may have retained
      // this snapshot before installing failed or temporary-source cleanup interrupted it.
      {
        const current = yield* (yield* LibraryStore).load;
        phase = "install";
        const reconciled = yield* progress.around(
          { kind: "projection", subject },
          updateInstalledSkills({
            roots: options.roots,
            variantsPath: store.variantsPath,
            onlyScopes: enabledByScope(current).filter((list) =>
              list.enabled.some((item) =>
                "collection" in item
                  ? item.collection === collectionId
                  : current.skills.some(
                      (skill) =>
                        skill.skill_id === item.skill && skill.collection_id === collectionId,
                    ),
              ),
            ),
          }),
          (value) => ({ kind: "projections-reconciled", projected: value.projected }),
        );
        projected = reconciled.projected;
      }
      const after = yield* (yield* LibraryStore).load;
      const retainedTree = after.collection_versions.find(
        (tree) => tree.collection_version_id === retained.collection_version_id,
      );
      return {
        subject_id: before.subjectId,
        subject_kind: before.kind,
        previous_collection_version_id: priorTree.collection_version_id,
        selected_collection_version_id: retained.collection_version_id,
        snapshot_digest: retained.snapshot_digest,
        changed,
        installed: projected,
        label: before.label,
        ...("diagnostics" in retained && retained.diagnostics?.length
          ? { diagnostics: retained.diagnostics }
          : {}),
        ...skillChanges(
          state,
          collectionId,
          priorTree.members,
          (retainedTree?.members ?? []).map((member) => ({
            source_path: member.source_path,
            artifact_digest: member.artifact_digest,
            name:
              after.skills.find(
                (skill) =>
                  skill.collection_id === collectionId && skill.path === member.source_path,
              )?.name ?? member.source_path,
          })),
        ),
      };
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        // Recover at the Collection boundary after its scopes close. Programming defects,
        // interruption, and failures accessing shared Library storage remain fatal.
        const recovery = yield* Effect.forEach(cause.reasons, (reason) =>
          Effect.gen(function* () {
            if (Cause.isInterruptReason(reason)) return false;
            const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
            if (
              Predicate.isTagged(error, "InvalidLibraryState") ||
              Predicate.isTagged(error, "LibraryBusy") ||
              Predicate.isTagged(error, "LibraryChanged") ||
              Predicate.isTagged(error, "ContentAddressCollision") ||
              Predicate.isTagged(error, "MachineSettingsUnusable")
            )
              return false;
            if (isPlatformError(error)) {
              const path =
                "pathOrDescriptor" in error.reason ? error.reason.pathOrDescriptor : undefined;
              if (typeof path === "string") {
                const canonical = yield* canonicalStoragePath(path).pipe(
                  Effect.catchCause(() => Effect.failCause(cause)),
                );
                if (canonical === storeHome || canonical.startsWith(`${storeHome}/`)) return false;
              }
              return (
                Cause.isFailReason(reason) || error.reason.method === "makeTempDirectoryScoped"
              );
            }
            return Cause.isFailReason(reason);
          }),
        );
        if (!recovery.every(Boolean)) return yield* Effect.failCause(cause);
        return yield* Effect.gen(function* () {
          // Source publication can succeed before its temporary checkout fails to close.
          // Inspect persisted evidence rather than claiming that such an update was rolled back.
          if (!sourceRetained) {
            const current = yield* store.load;
            const previous = latestSourceImport(state, before);
            const latest = latestSourceImport(current, before);
            sourceRetained = latest !== undefined && latest.import_id !== previous?.import_id;
          }
          const error = commandFailure(cause);
          return {
            status: "failed" as const,
            subject_id: before.subjectId,
            subject_kind: before.kind,
            label: before.label,
            source,
            phase,
            source_imported: sourceRetained,
            error: sourceRetained
              ? {
                  ...error,
                  remediation: `${error.remediation} Run \`skit update ${before.subjectId}\` to retry this Collection and update its installed skills.`,
                }
              : error,
          };
        });
      }),
    ),
  );
}, withLibraryWriter);
