import { join } from "node:path";
import { InstalledSkills } from "../../installed-skills.js";
import { libraryStateRevision, type LibraryState } from "../../library-state.js";
import { type SkillId } from "../../entity-ids.js";
import {
  DestinationsIncomplete,
  Plan,
  type AppliedChange,
  type EnabledChange,
  type InstalledSkillResult,
  type Outcome,
} from "../../library-plan.js";

import { canonicalJson } from "../../../shared/json.js";
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** The public result of one enabled change, derived only from what the Library recorded. */
export const finishChange = (
  change: EnabledChange,
  skillIds: readonly SkillId[],
  targets: readonly InstalledSkills.Destination[],
  copies: readonly InstalledSkillResult[],
  state: LibraryState,
): AppliedChange => {
  const installedSkills = state.installed_skills.filter(
    (copy) =>
      skillIds.includes(copy.skill_id) &&
      targets.some(
        (target) => copy.destination === target.destination && copy.root === target.root,
      ),
  );
  const paths =
    change._tag === "Enable"
      ? targets.flatMap((target) =>
          change.skills.map((name) => ({
            destination: target.destination,
            path: join(target.root, name),
          })),
        )
      : [];
  const unresolved = [
    ...new Set([
      ...paths
        .filter(
          (path) =>
            !installedSkills.some(
              (copy) =>
                copy.path === path.path &&
                copy.destination === path.destination &&
                copy.status === "installed",
            ),
        )
        .map((path) => path.path),
      ...installedSkills
        .filter(
          (copy) =>
            change._tag !== "Enable" ||
            copy.status !== "installed" ||
            !paths.some((path) => path.path === copy.path && path.destination === copy.destination),
        )
        .map((copy) => copy.path),
    ]),
  ];
  return {
    change,
    intent: change.changed ? "saved" : "unchanged",
    revision: libraryStateRevision(state),
    installedSkills,
    copies: copies.filter(
      (copy) => copy._tag !== "Failed" && skillIds.includes(copy.copy.skill_id),
    ),
    unresolved,
  };
};

/** Preserve the original reviewed change in the caller's result, including after a replay. */
export const applyOutcome = (plan: Plan, state: LibraryState, outcome: Outcome): Outcome => {
  const results = plan.changes.flatMap((change) => {
    if (change._tag !== "Enable" && change._tag !== "Disable") return [];
    const skillIds = plan.next.skills
      .filter(
        (skill) =>
          (skill.skill_id === change.subject_id || skill.collection_id === change.subject_id) &&
          change.skills.includes(skill.name),
      )
      .map((skill) => skill.skill_id);
    const targets =
      plan.routes.find((route) => same(route.scope, change.scope))?.destinations ?? [];
    return [
      finishChange(
        change,
        skillIds,
        targets,
        outcome._tag === "Applied" ? outcome.copies : [],
        state,
      ),
    ];
  });
  const unresolved = results.flatMap((result) => result.unresolved);
  if (outcome._tag === "Applied" && unresolved.length)
    return {
      _tag: "Incomplete",
      results,
      reason: "destinations",
      cause: new DestinationsIncomplete({ paths: unresolved }),
    };
  return { ...outcome, results };
};
