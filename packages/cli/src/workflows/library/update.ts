import { LibraryStore, type LibraryState } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import { addLibrarySourceEffect, inspectLibrarySourceEffect, type AddOptions } from "./add.js";
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

export interface UpdateOptions extends AddOptions {
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
        options,
        yield* subjectSourceEffect(subject, acquisition.input.value),
      );
      return {
        subject_id: subject.subjectId,
        subject_kind: subject.kind,
        current_snapshot_digest: tree.digest,
        available_snapshot_digest: inspected.snapshot_digest,
        changed: tree.digest !== inspected.snapshot_digest,
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
      addLibrarySourceEffect(options, yield* subjectSourceEffect(before, acquisition.input.value)),
    );
    const changed = retained.snapshot_digest !== priorTree.digest;
    let projected = 0;
    let deferred = 0;
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
            binding.skills.some((skillId) =>
              before.skills.some((skill) => skill.skill_id === skillId),
            ),
          ),
        }),
      );
      projected = reconciled.projected;
      deferred = reconciled.deferred;
    }
    results.push({
      subject_id: before.subjectId,
      subject_kind: before.kind,
      previous_retained_copy_id: priorTree.retained_copy_id,
      selected_retained_copy_id: retained.retained_version_id,
      snapshot_digest: retained.snapshot_digest,
      changed,
      projected,
      deferred,
    });
  }
  return results;
});
