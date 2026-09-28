import { bindingSkillIds, LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { addLibrarySourceEffect, inspectLibrarySourceEffect } from "./add.js";
import type { UpdateResult } from "./update-contract.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  latestSubjectAcquisition,
  resolveOwningLibrarySubjects,
  type LibrarySubject,
} from "./subject-resolution.js";
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
 * What a refresh of one Collection means for this device: Skills a followed Collection installs
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
    installed: followed ? added.map((member) => member.name) : [],
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
      );
      const members = ("members" in inspected ? inspected.members : undefined) ?? [];
      return {
        subject_id: subject.subjectId,
        subject_kind: subject.kind,
        current_snapshot_digest: tree.digest,
        available_snapshot_digest: inspected.snapshot_digest,
        changed: tree.digest !== inspected.snapshot_digest,
        label: subject.label,
        ...skillChanges(
          state,
          acquisition.collection_id,
          tree.members,
          inspected.skills.map((skill) => ({
            source_path: skill.verbatim_path,
            name: skill.name,
            ...(members.find((member) => member.source_path === skill.verbatim_path) ?? {}),
          })),
        ),
      };
    }),
  );
});

export const updateSubjectsEffect = Effect.fn("Library.updateSubjects")(function* (
  state: LibraryState,
  options: UpdateOptions,
  query?: string,
) {
  const selected = yield* selectSubjects(state, query);
  const renderer = yield* Renderer;
  const results: UpdateResult[number][] = [];
  for (const before of selected) {
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
    const retained = yield* renderer.withStatus(
      {
        pending: `${before.label} · Fetching and inspecting Source`,
        complete: (value) =>
          value.snapshot_digest === priorTree.digest
            ? `${before.label} · Source is current`
            : `${before.label} · New snapshot retained`,
      },
      addLibrarySourceEffect(yield* subjectSourceEffect(before, acquisition.input.value)),
    );
    const changed = retained.snapshot_digest !== priorTree.digest;
    let projected = 0;
    let deferred = 0;
    const collectionId =
      before.kind === "collection" ? before.collection.collection_id : before.skill.collection_id;
    if (changed) {
      const current = yield* (yield* LibraryStore).load;
      const reconciled = yield* renderer.withStatus(
        {
          pending: `${before.label} · Updating projected Skills`,
          complete: (value) =>
            value.projected
              ? `${before.label} · ${value.projected} projected Skill${value.projected === 1 ? "" : "s"} updated`
              : value.deferred
                ? `${before.label} · ${value.deferred} projected Skill${value.deferred === 1 ? "" : "s"} deferred`
                : `${before.label} · No projected Skills needed updating`,
        },
        reconcileLibraryProjections({
          roots: options.roots,
          variantsPath: options.variantsPath,
          onlyBindings: [...current.global_bindings, ...current.local_bindings].filter((binding) =>
            binding.entries.some((entry) =>
              entry.kind === "collection"
                ? entry.collection_id === collectionId
                : current.skills.some(
                    (skill) =>
                      skill.skill_id === entry.skill_id && skill.collection_id === collectionId,
                  ),
            ),
          ),
        }),
      );
      projected = reconciled.projected;
      deferred = reconciled.deferred;
    }
    const after = yield* (yield* LibraryStore).load;
    const retainedTree = after.retained_copies.find(
      (tree) => tree.retained_copy_id === retained.retained_version_id,
    );
    results.push({
      subject_id: before.subjectId,
      subject_kind: before.kind,
      previous_retained_copy_id: priorTree.retained_copy_id,
      selected_retained_copy_id: retained.retained_version_id,
      snapshot_digest: retained.snapshot_digest,
      changed,
      projected,
      deferred,
      label: before.label,
      ...skillChanges(
        state,
        collectionId,
        priorTree.members,
        (retainedTree?.members ?? []).map((member) => ({
          source_path: member.source_path,
          artifact_digest: member.artifact_digest,
          name:
            after.skills.find(
              (skill) => skill.collection_id === collectionId && skill.path === member.source_path,
            )?.name ?? member.source_path,
        })),
      ),
    });
  }
  return results;
});
