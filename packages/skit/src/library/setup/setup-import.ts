import { Data, Effect, Schema } from "effect";
import { sourceLocator } from "../../sources/resolve.js";
import { type ImportRequest } from "../import-collection.js";
import { type MachineId } from "../entity-ids.js";
import { SetupKnownSourceSelection, type SetupResult } from "./setup-contract.js";
import { prepareSkillsShImportEvidence } from "./skills-sh-lock-source.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class SetupImportInvalid
  extends Data.TaggedError("SetupImportInvalid")<{
    name: string;
    reason:
      | "duplicate-selection"
      | "candidate-not-found"
      | "candidate-not-importable"
      | "observation-missing"
      | "contested-observation"
      | "source-unresolvable"
      | "lock-changed";
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

/**
 * The import each selected Collection group makes, from one revalidated observation: one request
 * per group, in group order, each lockfile's hash checked as it is read.
 */
export const setupImportRequests = Effect.fn("Setup.importRequests")(function* (
  current: SetupResult,
  untrustedSelections: readonly unknown[],
  machineId: MachineId,
  checkedAt: string,
) {
  const selections = yield* Schema.decodeUnknownEffect(Schema.Array(SetupKnownSourceSelection))(
    untrustedSelections,
  );
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
  const requests: ImportRequest[] = [];
  for (const [groupKey, candidates] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const evidence = yield* prepareSkillsShImportEvidence(
      groupKey,
      candidates,
      current.instances,
      machineId,
      checkedAt,
    ).pipe(
      Effect.catchTag("SkillsShImportEvidenceInvalid", ({ name, reason }) =>
        Effect.fail(new SetupImportInvalid({ name, reason })),
      ),
    );
    requests.push({
      input: sourceLocator(evidence.source),
      source: evidence.source,
      importedAt: checkedAt,
      skills: evidence.skills,
      lockFileEntries: evidence.lockFileEntries,
    });
  }
  return requests;
});
