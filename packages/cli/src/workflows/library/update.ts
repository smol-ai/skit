import { bindingSkillIds, LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Cause, Effect, FileSystem, Predicate, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { addLibrarySourceEffect, inspectLibrarySourceEffect } from "./add.js";
import type { UpdateFailure, UpdateResult } from "./update-contract.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  latestSubjectAcquisition,
  resolveOwningLibrarySubjects,
  type LibrarySubject,
} from "./subject-resolution.js";
import { dirname, join, resolve } from "node:path";
import { isPlatformError } from "effect/PlatformError";
import { commandFailure } from "../../application.js";
import { sourceLocator } from "@smolai/skit-core";
import { sourceFromUpstream } from "./upstream-source.js";

export class UpdateNotRefreshable extends Schema.TaggedError<UpdateNotRefreshable>()(
  "Library.UpdateNotRefreshable",
  {
    subject_id: Schema.String,
    label: Schema.String,
    source: Schema.optionalKey(Schema.String),
  },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  get message(): string {
    return `${this.label} has no upstream source`;
  }
  get remediation(): string {
    return this.source === undefined
      ? "Add its source again to update it."
      : `Run \`skit add ${this.source}\` to update it.`;
  }
}

export interface UpdateOptions {
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const selectSubjects = Effect.fn("Library.selectUpdates")(function* (
  state: LibraryState,
  query?: string,
) {
  const matches = yield* resolveOwningLibrarySubjects(state, query);
  if (query === undefined)
    return matches.filter(
      (subject) =>
        latestSubjectAcquisition(state, subject) !== undefined &&
        subject.kind === "collection" &&
        subject.collection.upstream !== undefined,
    );
  return matches;
});

const subjectSourceEffect = Effect.fn("Library.updateSource")(function* (
  subject: LibrarySubject,
  sourceInput?: string,
) {
  const upstream = subject.kind === "collection" ? subject.collection.upstream : undefined;
  const resolved = upstream === undefined ? undefined : sourceFromUpstream(upstream);
  if (resolved === undefined)
    return yield* new UpdateNotRefreshable({
      subject_id: subject.subjectId,
      label: subject.label,
      ...(sourceInput === undefined ? {} : { source: sourceInput }),
    });
  return resolved;
});

/**
 * What a refresh of one Collection means for this device: Skills a followed Collection enables
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
  const bindings = [...state.global_bindings, ...state.local_bindings];
  const followed = bindings.some((binding) =>
    binding.entries.some(
      (entry) => entry.kind === "collection" && entry.collection_id === collectionId,
    ),
  );
  const individual = new Set<string>(
    bindings.flatMap((binding) =>
      binding.entries.flatMap((entry) => (entry.kind === "skill" ? [entry.skill_id] : [])),
    ),
  );
  const enabled = new Set<string>(bindings.flatMap((binding) => bindingSkillIds(state, binding)));
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

export const planUpdatesEffect = Effect.fn("Library.planUpdates")(function* (
  state: LibraryState,
  options: UpdateOptions,
  query?: string,
) {
  const selected = yield* selectSubjects(state, query);
  return yield* Effect.forEach(selected, (subject) =>
    Effect.gen(function* () {
      const acquisition = latestSubjectAcquisition(state, subject);
      if (acquisition === undefined)
        return yield* new UpdateNotRefreshable({
          subject_id: subject.subjectId,
          label: subject.label,
        });
      const tree = state.retained_copies.find(
        (candidate) => candidate.retained_copy_id === acquisition.retained_copy_id,
      );
      if (tree === undefined)
        return yield* new UpdateNotRefreshable({
          subject_id: subject.subjectId,
          label: subject.label,
        });
      const inspected = yield* inspectLibrarySourceEffect(
        yield* subjectSourceEffect(subject, acquisition.input.value),
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
    }),
  );
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

/** Preserve a uniform failure code; mixed success or failure types use the batch code. */
export function updateExitCode(outcomes: UpdateResult): number {
  const failures = outcomes.filter((item) => "status" in item);
  if (failures.length === 0) return 0;
  const code = failures[0]!.error.exitCode;
  return failures.length === outcomes.length &&
    failures.every((item) => item.error.exitCode === code)
    ? code
    : 1;
}

export const updateSubjectsEffect = Effect.fn("Library.updateSubjects")(function* (
  state: LibraryState,
  options: UpdateOptions,
  query?: string,
) {
  const selected = yield* selectSubjects(state, query);
  const renderer = yield* Renderer;
  const store = yield* LibraryStore;
  const storeHome = yield* canonicalStoragePath(store.home);
  const results: UpdateResult[number][] = [];
  for (const before of selected) {
    let phase: UpdateFailure["phase"] = "source";
    let source = before.label;
    let sourceRetained = false;
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const acquisition = latestSubjectAcquisition(state, before);
        if (acquisition === undefined)
          return yield* new UpdateNotRefreshable({
            subject_id: before.subjectId,
            label: before.label,
          });
        const priorTree = state.retained_copies.find(
          (tree) => tree.retained_copy_id === acquisition.retained_copy_id,
        );
        if (priorTree === undefined)
          return yield* new UpdateNotRefreshable({
            subject_id: before.subjectId,
            label: before.label,
          });
        const input = yield* subjectSourceEffect(before, acquisition.input.value);
        source = sourceLocator(input);
        const retained = yield* renderer.withStatus(
          {
            pending: `${before.label} · Fetching and inspecting Source`,
            complete: (value) =>
              value.snapshot_digest === priorTree.digest
                ? `${before.label} · Source is current`
                : `${before.label} · New snapshot retained`,
          },
          addLibrarySourceEffect(
            input,
            undefined,
            priorTree.members.map((member) => member.source_path),
          ),
        );
        sourceRetained = true;
        const changed = retained.snapshot_digest !== priorTree.digest;
        let projected = 0;
        const collectionId =
          before.kind === "collection"
            ? before.collection.collection_id
            : before.skill.collection_id;
        // Reconcile even when the Source is current: a previous run may have retained
        // this snapshot before projection failed or temporary-source cleanup interrupted it.
        {
          const current = yield* (yield* LibraryStore).load;
          phase = "projection";
          const reconciled = yield* renderer.withStatus(
            {
              pending: `${before.label} · Updating projected Skills`,
              complete: (value) =>
                value.projected
                  ? `${before.label} · ${value.projected} projected Skill${value.projected === 1 ? "" : "s"} updated`
                  : `${before.label} · No projected Skills needed updating`,
            },
            reconcileLibraryProjections({
              roots: options.roots,
              variantsPath: options.variantsPath,
              onlyBindings: [...current.global_bindings, ...current.local_bindings].filter(
                (binding) =>
                  binding.entries.some((entry) =>
                    entry.kind === "collection"
                      ? entry.collection_id === collectionId
                      : current.skills.some(
                          (skill) =>
                            skill.skill_id === entry.skill_id &&
                            skill.collection_id === collectionId,
                        ),
                  ),
              ),
            }),
          );
          projected = reconciled.projected;
        }
        const after = yield* (yield* LibraryStore).load;
        const retainedTree = after.retained_copies.find(
          (tree) => tree.retained_copy_id === retained.retained_version_id,
        );
        return {
          subject_id: before.subjectId,
          subject_kind: before.kind,
          previous_retained_copy_id: priorTree.retained_copy_id,
          selected_retained_copy_id: retained.retained_version_id,
          snapshot_digest: retained.snapshot_digest,
          changed,
          projected,
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
                Predicate.isTagged(error, "ContentAddressCollision")
              )
                return false;
              if (isPlatformError(error)) {
                const path =
                  "pathOrDescriptor" in error.reason ? error.reason.pathOrDescriptor : undefined;
                if (typeof path === "string") {
                  const canonical = yield* canonicalStoragePath(path).pipe(
                    Effect.catchCause(() => Effect.failCause(cause)),
                  );
                  if (canonical === storeHome || canonical.startsWith(`${storeHome}/`))
                    return false;
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
              const previous = latestSubjectAcquisition(state, before);
              const latest = latestSubjectAcquisition(current, before);
              sourceRetained =
                latest !== undefined && latest.acquisition_id !== previous?.acquisition_id;
            }
            const error = commandFailure(cause);
            return {
              status: "failed" as const,
              subject_id: before.subjectId,
              subject_kind: before.kind,
              label: before.label,
              source,
              phase,
              source_retained: sourceRetained,
              error: sourceRetained
                ? {
                    ...error,
                    remediation: `${error.remediation} Run \`skit update ${before.subjectId}\` to retry this Collection and reconcile its projections.`,
                  }
                : error,
            };
          });
        }),
      ),
    );
    results.push(outcome);
  }
  return results;
});
