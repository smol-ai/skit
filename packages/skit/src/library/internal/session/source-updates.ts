import { Data, Effect } from "effect";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { enabledByScope } from "../../enabled.js";
import { enabledSkillIds, type SkitSource } from "../../library-contracts.js";
import type { LibraryState } from "../../library-state.js";
import {
  latestSourceImport,
  resolveOwningLibrarySubjects,
  type LibrarySubject,
} from "../../subject-resolution.js";
import { sourceFromUpstream } from "./upstream-source.js";
import type { inspectResolvedSource } from "../../source-inspection.js";
export type SourceInspection = Effect.Success<ReturnType<typeof inspectResolvedSource>>;

export interface LibraryProgressSubject {
  readonly id: string;
  readonly label: string;
}

export type LibraryProgressStage =
  | { readonly kind: "source"; readonly subject: LibraryProgressSubject }
  | { readonly kind: "install"; readonly subject: LibraryProgressSubject };

export type LibraryProgressCompletion =
  | { readonly kind: "source-inspected"; readonly changed: boolean }
  | { readonly kind: "installed-skills-updated"; readonly installed: number };

export interface LibraryProgressReporter {
  readonly around: <A, E, R>(
    stage: LibraryProgressStage,
    operation: Effect.Effect<A, E, R>,
    completed: (value: A) => LibraryProgressCompletion,
  ) => Effect.Effect<A, E, R>;
}

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
export const skillChanges = (
  state: LibraryState,
  collectionId: string,
  previous: ReadonlyArray<{ readonly source_path: string; readonly artifact_hash: string }>,
  observed: ReadonlyArray<{
    readonly source_path: string;
    readonly name: string;
    readonly artifact_hash?: string;
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
        member.artifact_hash !== undefined &&
        member.artifact_hash !== before.artifact_hash &&
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

export const resolveUpdate = Effect.fn("Library.resolveCollectionUpdate")(function* (
  state: LibraryState,
  subject: LibrarySubject,
) {
  const sourceImport = latestSourceImport(state, subject);
  const priorTree =
    sourceImport === undefined
      ? undefined
      : state.collection_versions.find(
          (tree) => tree.collection_version_id === sourceImport.collection_version_id,
        );
  if (sourceImport === undefined || priorTree === undefined)
    return yield* new CollectionNotUpdatable({
      subject_id: subject.subjectId,
      label: subject.label,
    });
  const input = yield* subjectSource(subject, sourceImport.input.value);
  return { acquisition: sourceImport, priorTree, input };
});

/** Observe one Collection without retaining content or reconciling installed skills. */
const previewCollectionUpdate = Effect.fn("Library.previewCollectionUpdate")(function* <E, R>(
  state: LibraryState,
  subject: LibrarySubject,
  inspectSource: (
    input: SkitSource,
    previousSkillPaths?: readonly string[],
  ) => Effect.Effect<SourceInspection, E, R>,
) {
  const {
    acquisition: sourceImport,
    priorTree: tree,
    input,
  } = yield* resolveUpdate(state, subject);
  const inspected = yield* inspectSource(
    input,
    tree.members.map((member) => member.source_path),
  );
  const members = ("members" in inspected ? inspected.members : undefined) ?? [];
  return {
    subject_id: subject.subjectId,
    subject_kind: subject.kind,
    current_snapshot_digest: tree.hash,
    available_snapshot_digest: inspected.snapshot_digest,
    changed: tree.hash !== inspected.snapshot_digest,
    label: subject.label,
    ...("diagnostics" in inspected && inspected.diagnostics?.length
      ? { diagnostics: inspected.diagnostics }
      : {}),
    ...skillChanges(
      state,
      sourceImport.collection_id,
      tree.members,
      inspected.skills.map((skill) => ({
        source_path: skill.verbatim_path,
        name: skill.name,
        ...members.find((member) => member.source_path === skill.verbatim_path),
      })),
    ),
  };
});

const selectSubjects = Effect.fn("Library.selectUpdates")(function* (
  state: LibraryState,
  query?: string,
) {
  const matches = yield* resolveOwningLibrarySubjects(state, query);
  if (query === undefined)
    return matches.filter(
      (subject) =>
        latestSourceImport(state, subject) !== undefined &&
        subject.kind === "collection" &&
        subject.collection.upstream !== undefined,
    );
  return matches;
});

/** Read-only Source updates from the exact Library view displayed. */
export const previewSourceUpdates = Effect.fn("Library.previewSourceUpdates")(function* <E, R>(
  state: LibraryState,
  query: string | undefined,
  inspectSource: (
    input: SkitSource,
    previousSkillPaths?: readonly string[],
  ) => Effect.Effect<SourceInspection, E, R>,
) {
  return yield* Effect.forEach(yield* selectSubjects(state, query), (subject) =>
    previewCollectionUpdate(state, subject, inspectSource),
  );
});
export { selectSubjects };
