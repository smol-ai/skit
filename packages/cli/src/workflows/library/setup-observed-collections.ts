import { Data, Effect, Schema } from "effect";
import { importCollection, LibraryStore, sourceLocator } from "@smolai/skit-core";
import { type SetupOptions } from "./setup.js";
import { SetupKnownSourceSelection, type SetupResult } from "./setup-contract.js";
import { prepareSkillsShImportEvidence } from "./skills-sh-lock-source.js";
import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";

export class SetupImportInvalid
  extends Data.TaggedError("SetupImportInvalid")<{
    name: string;
    reason:
      | "duplicate-selection"
      | "candidate-not-found"
      | "candidate-not-importable"
      | "machine-identity-missing"
      | "observation-missing"
      | "contested-observation"
      | "source-unresolvable"
      | "lock-changed"
      | "retention-missing";
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation = "Run `skit setup` again and review the current plan.";
  get message(): string {
    return `Cannot import ${this.name} during setup: ${this.reason}`;
  }
}

export interface SetupImportOptions {
  readonly setup: SetupOptions;
}

/** Retain selected installed bytes from one freshly revalidated observation. */
export const importSetupCollections = Effect.fn("Setup.applyObservedCollections")(function* (
  options: SetupImportOptions,
  current: SetupResult,
  untrustedSelections: readonly unknown[],
) {
  const selections = yield* Schema.decodeUnknownEffect(Schema.Array(SetupKnownSourceSelection))(
    untrustedSelections,
  );
  const machineId = current.machineConfig.machineId;
  if (!machineId)
    return yield* new SetupImportInvalid({
      name: "machine",
      reason: "machine-identity-missing",
    });
  const selected = new Set<string>();
  const groups = new Map<
    string,
    Array<
      Extract<
        (typeof current.onboarding.candidates)[number],
        { action: "import-observed-collection" }
      >
    >
  >();
  for (const selection of selections) {
    const key = `${selection.groupKey}\0${selection.name}\0${[...selection.paths].sort().join("\0")}`;
    if (selected.has(key))
      return yield* new SetupImportInvalid({
        name: selection.name,
        reason: "duplicate-selection",
      });
    selected.add(key);
    const candidate = current.onboarding.candidates.find(
      (
        item,
      ): item is Extract<
        (typeof current.onboarding.candidates)[number],
        { action: "import-observed-collection" }
      > =>
        item.action === "import-observed-collection" &&
        item.groupKey === selection.groupKey &&
        item.name === selection.name &&
        selection.paths.length > 0 &&
        selection.paths.every((path) => item.paths.includes(path)),
    );
    if (!candidate)
      return yield* new SetupImportInvalid({
        name: selection.name,
        reason: "candidate-not-found",
      });
    groups.set(candidate.groupKey, [
      ...(groups.get(candidate.groupKey) ?? []),
      { ...candidate, paths: selection.paths },
    ]);
  }

  const observedAt = new Date(
    yield* Effect.clockWith((clock) => clock.currentTimeMillis),
  ).toISOString();
  const retained = [];
  for (const [groupKey, candidates] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const evidence = yield* prepareSkillsShImportEvidence(
      groupKey,
      candidates,
      current.instances,
      machineId,
      observedAt,
    ).pipe(
      Effect.catchTag("SkillsShImportEvidenceInvalid", ({ name, reason }) =>
        Effect.fail(new SetupImportInvalid({ name, reason })),
      ),
    );
    retained.push(
      yield* Effect.scoped(
        importCollection({
          input: sourceLocator(evidence.source),
          source: evidence.source,
          retainedAt: observedAt,
          skills: evidence.skills,
          observations: evidence.observations,
        }),
      ),
    );
  }
  const persisted = yield* (yield* LibraryStore).inspect;
  if (!persisted.present)
    return yield* new SetupImportInvalid({
      name: "Library",
      reason: "retention-missing",
    });
  for (const result of retained) {
    if (
      result.skills.length === 0 ||
      result.skills.some(
        (skill) =>
          !persisted.state.skills.some((candidate) => candidate.skill_id === skill.skill_id),
      )
    )
      return yield* new SetupImportInvalid({
        name: result.collection?.collection_id ?? result.skills[0]?.skill_id ?? "Library",
        reason: "retention-missing",
      });
  }
  return { planId: current.onboarding.planId, retained };
});
