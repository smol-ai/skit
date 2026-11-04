import { basename } from "node:path";
import { Data, Effect } from "effect";
import { hashParts } from "../../artifact/descriptor.js";
import { InstalledSkills } from "../installed-skills.js";
import { Library } from "../library.js";
import { planIntent } from "../plan-changes.js";
import { changeWrites } from "../installed-update.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";
import { type LibraryState } from "../library-state.js";
import { type InventoryRootOptions } from "../routing/roots.js";
import type {
  InstalledSkillChange,
  InstalledSkillChangeResult,
  SetupVersionChoice,
} from "./setup-contract.js";

export class ChangeChoiceRequired
  extends Data.TaggedError("ChangeChoiceRequired")<{
    readonly facts: readonly InstalledSkillChange[];
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return this.facts
      .map(
        (fact) =>
          `${fact.name} at ${fact.path}: ${fact.status === "competing" ? `current ${fact.currentHash} and the Library's ${fact.desiredHash} need a version choice` : (fact.reason ?? "custody needs resolution")}`,
      )
      .join("; ");
  }
  readonly remediation =
    "Review setup's current copy and Library-version facts before applying these unresolved changes.";
}

export const changesNeedingChoice = (
  facts: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[] = [],
) =>
  facts.filter(
    (fact) =>
      fact.status === "protected" ||
      (fact.status === "competing" && !choices.some((choice) => choice.skillId === fact.skillId)),
  );

/** Whether applying would write a copy or a record: what setup asks before touching any. */
const writes = changeWrites;

export const hasChangesToApply = (
  facts: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[] = [],
) => choices.length > 0 || facts.some(writes);

export const changeResults = (
  facts: readonly InstalledSkillChange[],
  applied: boolean,
): InstalledSkillChangeResult[] =>
  facts.map((fact) => ({
    ...(fact.installedSkillId === undefined ? {} : { installedSkillId: fact.installedSkillId }),
    name: fact.name,
    path: fact.path,
    status:
      fact.status === "install"
        ? applied
          ? ("installed" as const)
          : ("pending" as const)
        : fact.status === "local-only"
          ? ("local-kept" as const)
          : fact.status === "native-delete"
            ? ("native-delete" as const)
            : fact.status === "uninstall"
              ? applied
                ? ("uninstalled" as const)
                : ("pending" as const)
              : fact.status === "incoming-update" || fact.metadataChanged
                ? applied
                  ? ("updated" as const)
                  : ("pending" as const)
                : ("unchanged" as const),
  }));

/** Alternatives are derived once by the application; adapters only select these values. */
export const setupVersionAlternatives = (facts: readonly InstalledSkillChange[]) => {
  const skills = [
    ...new Set(facts.filter((fact) => fact.status === "competing").map((fact) => fact.skillId)),
  ];
  return skills.flatMap((skillId) => {
    const copies = facts.filter((fact) => fact.skillId === skillId);
    if (copies.some((fact) => fact.status === "protected")) return [];
    return [
      { skillId, version: "retained" as const },
      ...copies
        .filter((fact) => fact.currentHash !== undefined)
        .map((fact) => ({
          skillId,
          version: "local" as const,
          path: fact.path,
        })),
    ];
  });
};

/** What updating every installed copy would do, as setup reviews it. Changes nothing. */
export const planInstalledSkillChanges = Effect.fn("Setup.planInstalledSkillChanges")(function* (
  state: LibraryState,
  roots: InventoryRootOptions,
) {
  const files = yield* InstalledSkills.make(roots);
  return yield* planIntent({ _tag: "Update" }, { base: state }).pipe(
    Effect.provideService(InstalledSkills.Service, files),
    Effect.map(Library.reviewInstalledSkillChanges),
    // Setup still discovers when the Library cannot plan its copies, and touches none of them.
    Effect.catch((error) =>
      Effect.succeed(
        state.installed_skills.flatMap((copy): InstalledSkillChange[] => [
          {
            installedSkillId: copy.installed_skill_id,
            skillId: copy.skill_id,
            name:
              state.skills.find((skill) => skill.skill_id === copy.skill_id)?.name ??
              basename(copy.path),
            path: copy.path,
            destination: copy.destination,
            baselineHash: copy.expected_hash,
            evidence: hashParts([copy.path, "unplanned"]),
            status: "protected",
            reason: `The Library cannot plan its installed copies: ${error.message}`,
            metadataChanged: false,
          },
        ]),
      ),
    ),
  );
});
