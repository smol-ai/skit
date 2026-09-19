import { LibraryStore, type LibraryState, type SkitSource } from "@smolai/skit-core";
import { Effect, Schema } from "effect";
import type { InventoryRootOptions } from "../../projection/roots.js";
import {
  addLibrarySourceEffect,
  acquisitionSourceEffect,
  inspectLibrarySourceEffect,
  type AddOptions,
} from "./add.js";
import type { UpdateResult } from "./update-contract.js";
import { reconcileLibraryProjections } from "./projection-reconciliation.js";
import { Renderer } from "../../presentation/renderer.js";
import {
  latestSubjectAcquisition,
  matchingLibrarySubjects,
  type LibrarySubject,
} from "./subject-resolution.js";

export class UpdateNotFound extends Schema.TaggedError<UpdateNotFound>()("Library.UpdateNotFound", {
  query: Schema.String,
}) {
  readonly code = "NOT_FOUND" as const;
  readonly exitCode = 11;
  readonly remediation = "Run `skit list` to find a retained Skill or Collection.";
}
export class UpdateAmbiguous extends Schema.TaggedError<UpdateAmbiguous>()(
  "Library.UpdateAmbiguous",
  { query: Schema.String },
) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "Use a Skill or Collection ID to select one subject.";
}
export class UpdateNoSource extends Schema.TaggedError<UpdateNoSource>()("Library.UpdateNoSource", {
  subject_id: Schema.String,
}) {
  readonly code = "CONFLICT" as const;
  readonly exitCode = 12;
  readonly remediation = "This Library subject has no source to validate for update.";
}

export interface UpdateOptions extends AddOptions {
  readonly roots: InventoryRootOptions;
  readonly variantsPath: string;
}

const selectSubjects = Effect.fn("Library.selectUpdates")(function* (
  state: LibraryState,
  query?: string,
) {
  const matches = matchingLibrarySubjects(state, query);
  if (query === undefined)
    return matches.filter(
      (subject) =>
        latestSubjectAcquisition(state, subject) !== undefined &&
        (subject.kind === "collection" || subject.skill.upstream !== undefined),
    );
  if (matches.length === 0) return yield* new UpdateNotFound({ query });
  if (matches.length !== 1) return yield* new UpdateAmbiguous({ query });
  return matches;
});

const subjectSourceEffect = Effect.fn("Library.updateSource")(function* (
  subject: LibrarySubject,
  acquisition: LibraryState["acquisitions"][number],
) {
  if (subject.kind === "collection") return yield* acquisitionSourceEffect(acquisition);
  const upstream = subject.skill.upstream;
  if (
    upstream?.source_identity.kind !== "well-known" ||
    upstream.selection.kind !== "selected-skills"
  )
    return yield* new UpdateNoSource({ subject_id: subject.subjectId });
  const source: SkitSource = {
    type: "well-known",
    ref: upstream.source_identity.locator.value,
    members: upstream.selection.names,
  };
  return source;
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
        return yield* new UpdateNoSource({ subject_id: subject.subjectId });
      const tree = state.retained_copies.find(
        (candidate) => candidate.retained_copy_id === acquisition.retained_copy_id,
      );
      if (tree === undefined) return yield* new UpdateNotFound({ query: subject.subjectId });
      const inspected = yield* inspectLibrarySourceEffect(
        options,
        yield* subjectSourceEffect(subject, acquisition),
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
      return yield* new UpdateNoSource({ subject_id: before.subjectId });
    const priorTree = state.retained_copies.find(
      (tree) => tree.retained_copy_id === acquisition.retained_copy_id,
    );
    if (priorTree === undefined) return yield* new UpdateNotFound({ query: before.subjectId });
    const retained = yield* renderer.withStatus(
      {
        pending: `${before.label} · Fetching and inspecting Source`,
        complete: (value) =>
          value.snapshot_digest === priorTree.digest
            ? `${before.label} · Source is current`
            : `${before.label} · New snapshot retained`,
      },
      addLibrarySourceEffect(
        { ...options, standalone: before.kind === "skill" },
        yield* subjectSourceEffect(before, acquisition),
      ),
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
