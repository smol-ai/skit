import { basename } from "node:path";
import { Clock, Data, Effect } from "effect";
import {
  canonicalJson,
  hashParts,
  InstalledSkills,
  Library,
  FailureTypeId,
  type LibraryState,
  type SkitFailure,
} from "@smolai/skit-core";
import { make as makeInstalledSkills } from "../../install/installed-skills.js";
import type { InventoryRootOptions } from "../../install/roots.js";
import type {
  InstalledSkillChange,
  InstalledSkillChangeResult,
  SetupVersionChoice,
} from "./setup-contract.js";
import { PlanIsStale } from "../../library/failures.js";

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
          `${fact.name} at ${fact.path}: ${fact.status === "competing" ? `current ${fact.currentHash} and retained ${fact.desiredHash} need a version choice` : (fact.reason ?? "custody needs resolution")}`,
      )
      .join("; ");
  }
  readonly remediation =
    "Review setup's current copy and retained-version facts before applying these unresolved changes.";
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
const writes = (fact: InstalledSkillChange) =>
  fact.status === "incoming-update" ||
  fact.status === "install" ||
  fact.status === "uninstall" ||
  fact.metadataChanged;

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

const protection = {
  repository: "A repository owns this folder",
  authored: "An author's workspace owns this folder",
  "package-manager": "A package manager owns this folder",
} as const;

/** What setup shows of every copy in a Library plan, keyed by its path. */
const installedSkillChanges = (state: LibraryState, plan: Library.Plan) =>
  plan.changes
    .flatMap((change): InstalledSkillChange[] => {
      if (!("evidence" in change)) return [];
      const { destination, recorded } = change;
      if (destination === "legacy") return [];
      const record =
        recorded === undefined
          ? undefined
          : state.installed_skills.find(
              (copy) => copy.installed_skill_id === recorded.installedSkillId,
            );
      const fact = {
        ...(recorded === undefined
          ? {}
          : { installedSkillId: recorded.installedSkillId, baselineHash: recorded.hash }),
        skillId: change.skillId,
        name:
          state.skills.find((skill) => skill.skill_id === change.skillId)?.name ??
          basename(change.path),
        path: change.path,
        destination,
        ...(change.currentHash === undefined ? {} : { currentHash: change.currentHash }),
        ...(change.wantedHash === undefined ? {} : { desiredHash: change.wantedHash }),
        ...(change._tag === "Uninstall" || change._tag === "Forget" || change._tag === "Refuse"
          ? {}
          : { desiredVersionId: change.skillVersionId }),
        evidence: hashParts([change.evidence]),
        metadataChanged: false,
      };
      const kept = (reason: string): InstalledSkillChange => ({
        ...fact,
        status: "protected",
        reason,
      });
      switch (change._tag) {
        case "Unchanged":
          return [
            {
              ...fact,
              status: "unchanged",
              metadataChanged:
                record === undefined ||
                record.status !== "installed" ||
                record.skill_version_id !== change.skillVersionId ||
                record.expected_hash !== change.wantedHash,
            },
          ];
        case "Manage":
          return [{ ...fact, status: "unchanged", metadataChanged: true }];
        // With a record, SKIT puts back what it moved aside.
        case "Install":
          return [{ ...fact, status: recorded === undefined ? "install" : "incoming-update" }];
        case "Update":
          return [{ ...fact, status: "incoming-update" }];
        case "Conflict":
          if (!change.edited) return [kept("The folder holds what SKIT did not write")];
          // The edit already is the selected Version: only the marker changes.
          if (change.currentHash === change.wantedHash)
            return [{ ...fact, status: "unchanged", metadataChanged: true }];
          return [
            {
              ...fact,
              status:
                change.wantedHash === undefined || change.wantedHash === recorded?.hash
                  ? "local-only"
                  : "competing",
            },
          ];
        case "Protected":
          return [kept(protection[change.reason])];
        case "Unreadable":
          return [kept(`The folder cannot be read as a skill: ${change.reason}`)];
        case "Refuse":
          return [kept(change.detail)];
        case "KeepDeleted":
          return [{ ...fact, status: "native-delete", reason: "Native deletion is preserved" }];
        case "Uninstall":
        case "Forget":
          return [{ ...fact, status: "uninstall" }];
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path));

/** The Library owner routed by setup's roots. Built where it runs, so it saves through that store. */
const setupLibrary = Effect.fn("Setup.library")(function* (roots: InventoryRootOptions) {
  return yield* Library.make.pipe(
    Effect.provideService(InstalledSkills.Service, yield* makeInstalledSkills(roots)),
  );
});

/** What updating every installed copy would do, as setup reviews it. Changes nothing. */
export const planInstalledSkillChanges = Effect.fn("Setup.planInstalledSkillChanges")(function* (
  state: LibraryState,
  roots: InventoryRootOptions,
) {
  const library = yield* setupLibrary(roots);
  return yield* library.plan({ _tag: "Update" }, { base: state }).pipe(
    Effect.map((plan) => installedSkillChanges(state, plan)),
    // Setup still discovers when the Library cannot plan its copies, and touches none of them.
    Effect.catch((error) =>
      Effect.succeed(
        state.installed_skills.flatMap((copy): InstalledSkillChange[] =>
          copy.destination === "legacy"
            ? []
            : [
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
              ],
        ),
      ),
    ),
  );
});

/**
 * Apply reviewed changes to existing copies through the Library: each local choice becomes its
 * Skill's Version, then one update installs what was reviewed. `reviewed` is every change the
 * approved setup plan showed; anything the update would write must still be exactly that.
 */
export const applyInstalledSkillChanges = Effect.fn("Setup.applyInstalledSkillChanges")(function* (
  roots: InventoryRootOptions,
  reviewed: readonly InstalledSkillChange[],
  choices: readonly SetupVersionChoice[],
) {
  const library = yield* setupLibrary(roots);
  const chosen = new Set<string>(choices.map((choice) => choice.skillId));
  const local = reviewed.filter((fact) =>
    choices.some(
      (choice) =>
        choice.version === "local" && choice.skillId === fact.skillId && choice.path === fact.path,
    ),
  );
  for (const fact of local) {
    if (fact.currentHash === undefined || fact.installedSkillId === undefined)
      return yield* new PlanIsStale();
    yield* library.import.edit({
      skillId: fact.skillId,
      installedSkillId: fact.installedSkillId,
      path: fact.path,
      currentHash: fact.currentHash,
      importedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
    });
  }
  const state = yield* library.load;
  const planned = yield* library.plan({ _tag: "Update" }, { base: state });
  const marker = (path: string) => {
    const entry = planned.folders.find((folder) => folder.path === path)?.entry;
    return entry?._tag === "Present" && entry.facts?.marker.kind === "valid"
      ? entry.facts.marker.marker
      : undefined;
  };
  // An edit that already is the Version keeps its folder; a chosen Version replaces every other
  // reviewed edit of its Skill, which goes to recovery and is kept there.
  const approvals = planned.changes.flatMap((change): Library.Approval[] => {
    if (
      !("evidence" in change) ||
      change._tag !== "Conflict" ||
      !change.edited ||
      change.recorded === undefined
    )
      return [];
    const { installedSkillId } = change.recorded;
    if (reviewed.find((fact) => fact.path === change.path)?.currentHash !== change.currentHash)
      return [];
    const current = marker(change.path);
    const accept: Library.Approval[] =
      current === undefined ||
      (change.currentHash !== change.wantedHash && !local.some((fact) => fact.path === change.path))
        ? []
        : [
            {
              _tag: "AcceptEdit",
              installedSkillId,
              currentHash: change.currentHash,
              marker: current,
            },
          ];
    return chosen.has(change.skillId)
      ? [...accept, { _tag: "ReplaceEdit", installedSkillId, currentHash: change.currentHash }]
      : accept;
  });
  const plan = yield* library.plan({ _tag: "Update" }, { base: state, approvals });
  const facts = installedSkillChanges(state, plan);

  // Outside the chosen Skills, whatever the update writes is exactly what was reviewed.
  for (const fact of facts)
    if (
      !chosen.has(fact.skillId) &&
      writes(fact) &&
      canonicalJson(fact) !== canonicalJson(reviewed.find((item) => item.path === fact.path))
    )
      return yield* new PlanIsStale();
  // Setup does not show legacy records, so it never writes one.
  for (const change of plan.changes)
    if (
      "evidence" in change &&
      change.destination === "legacy" &&
      (change._tag === "Update" ||
        change._tag === "Manage" ||
        change._tag === "Uninstall" ||
        change._tag === "Refuse")
    )
      return yield* new PlanIsStale();
  // A chosen copy that the update would still leave edited was not the copy reviewed.
  for (const fact of facts)
    if (chosen.has(fact.skillId) && (fact.status === "competing" || fact.status === "local-only"))
      return yield* new PlanIsStale();

  const outcome = yield* library.apply(plan);
  const copies = outcome._tag === "Applied" ? outcome.copies : [];
  return facts.map((fact): InstalledSkillChangeResult => {
    const result = copies.find((copy) => copy._tag !== "Failed" && copy.copy.path === fact.path);
    const installedSkillId =
      result === undefined || result._tag === "Failed"
        ? fact.installedSkillId
        : result.copy.installed_skill_id;
    const at = {
      ...(installedSkillId === undefined ? {} : { installedSkillId }),
      name: fact.name,
      path: fact.path,
    };
    switch (result?._tag) {
      case "Installed":
        return { ...at, status: fact.status === "install" ? "installed" : "updated" };
      case "Conflicted":
        return { ...at, status: fact.status === "protected" ? "unchanged" : "local-kept" };
      case "Suppressed":
        return { ...at, status: "native-delete" };
      case "Uninstalled":
        return { ...at, status: "uninstalled" };
      case "Pending":
        return { ...at, status: "pending" };
      default:
        return {
          ...at,
          status:
            fact.status === "uninstall"
              ? "uninstalled"
              : fact.status === "install"
                ? "pending"
                : "unchanged",
        };
    }
  });
});
