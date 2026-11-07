import { finalRows, same, type ApplyStep } from "./program.js";
import { enabledAt } from "../../enabled.js";
import { join } from "node:path";
import * as InstalledSkills from "../../installed-skills.js";
import { libraryStateRevision, type LibraryState } from "../../library-state.js";
import { type SkillId } from "../../entity-ids.js";
import {
  DestinationsIncomplete,
  type AppliedChange,
  type EnabledChange,
  type InstalledSkillResult,
  type Outcome,
} from "../../library-plan.js";

/** The public result of one enabled change, derived only from what the Library recorded. */
const finishChange = (
  change: EnabledChange,
  skillIds: readonly SkillId[],
  targets: readonly InstalledSkills.Destination[],
  copies: readonly InstalledSkillResult[],
  state: LibraryState,
  expected: LibraryState["installed_skills"],
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
                copy.status === "installed" &&
                expected.some((wanted) => same(wanted, copy)),
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
      (copy) =>
        copy._tag !== "Failed" &&
        skillIds.includes(copy.copy.skill_id) &&
        targets.some(
          (target) =>
            copy.copy.root === target.root && copy.copy.destination === target.destination,
        ),
    ),
    unresolved,
    failure: null,
  };
};

/** Preserve the original reviewed change in the caller's result, including after a replay. */
export const applyOutcome = (step: ApplyStep, state: LibraryState, outcome: Outcome): Outcome => {
  const expected: LibraryState = { ...step.next, installed_skills: [], operations: [] };
  const expectedRows = finalRows(step);
  const requests = step.enabled
    .filter(({ change }) => {
      const found = enabledAt(state, change.scope);
      const wanted = enabledAt(expected, change.scope);
      return (
        same(found?.enabled ?? [], wanted?.enabled ?? []) &&
        same(found?.invocation_policies ?? {}, wanted?.invocation_policies ?? {})
      );
    })
    .map(({ change, skillIds, targets }) => ({
      paths: new Set([
        ...targets.flatMap((target) => change.skills.map((name) => join(target.root, name))),
        ...[...step.before.installed_skills, ...expectedRows]
          .filter(
            (copy) =>
              skillIds.includes(copy.skill_id) &&
              targets.some(
                (target) => target.root === copy.root && target.destination === copy.destination,
              ),
          )
          .map((copy) => copy.path),
      ]),
      result: finishChange(
        change,
        skillIds,
        targets,
        outcome._tag === "Applied" ? outcome.copies : [],
        state,
        expectedRows,
      ),
    }));
  const results = requests.map(({ result }) => result);
  const unresolved = results.flatMap((result) => result.unresolved);
  const completed: Outcome =
    outcome._tag === "Applied" && unresolved.length
      ? {
          _tag: "Incomplete",
          results,
          reason: "destinations",
          cause: new DestinationsIncomplete({ paths: unresolved }),
          failedPaths: unresolved,
        }
      : { ...outcome, results };
  if (completed._tag === "Applied") return completed;
  // A copy failure names its recorded path. A shared publication/finalization failure cannot
  // truthfully be blamed on one request, so every accepted request shares that failure.
  const failedPaths = completed.failedPaths;
  const shared =
    failedPaths === null ||
    !failedPaths.some((path) => requests.some((request) => request.paths.has(path)));
  return {
    ...completed,
    results: requests.map(({ result, paths }) => ({
      ...result,
      failure:
        shared || result.unresolved.length > 0 || failedPaths?.some((path) => paths.has(path))
          ? completed.cause
          : null,
    })),
  };
};
