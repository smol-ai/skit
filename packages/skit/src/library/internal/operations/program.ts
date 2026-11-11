import { Effect } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { InvalidLibraryState } from "../../failures.js";
import { libraryStatePath } from "../../store/library-store.js";
import type { Plan, InstalledSkillResult } from "../../library-plan.js";
import type { InstalledSkill } from "../../device-state.js";
import type { LibraryState } from "../../library-state.js";
import * as Status from "../../installed-skill-status.js";
import type {
  InstalledApply,
  RecordedInstalledChange,
  StepRouting,
} from "../../store/state-schema.js";

export type ApplyStep = InstalledApply;
export const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const publication = ({ operations: _operations, ...state }: LibraryState) => state;
export const body = ({ installed_skills: _rows, ...state }: ApplyStep["before"]) => state;

/** Compile decisions, including blocked-successor policy, before recording any work. */
export const compileApply = Effect.fn("Library.compileApply")(function* (
  plan: Plan,
  before: LibraryState,
  rows: ReadonlyMap<string, InstalledSkill>,
  routing: StepRouting,
  home: string,
) {
  const changes: RecordedInstalledChange[] = [];
  for (const change of plan.changes) {
    if ("subject_id" in change || change._tag === "Protected" || change._tag === "Refuse") continue;
    const path = "path" in change ? change.path : change.recorded.path;
    if (!plan.folders.some((folder) => folder.path === path))
      return yield* new InvalidLibraryState({
        path: libraryStatePath(home),
        reason: { _tag: "MissingRecord", record: "folder-evidence", at: path },
      });
    if ("skillVersionId" in change) {
      if (change._tag === "Unreadable") {
        changes.push({ _tag: "Fail", path: change.path, reason: change.reason });
        continue;
      }
      const row = rows.get(change.path);
      if (!row)
        return yield* new InvalidLibraryState({
          path: libraryStatePath(home),
          reason: { _tag: "MissingRecord", record: "installed-row", at: change.path },
        });
      switch (change._tag) {
        case "Install":
        case "Update":
        case "Manage":
          if (row.status !== "installed")
            return yield* new InvalidLibraryState({
              path: libraryStatePath(home),
              reason: { _tag: "InvalidData" },
            });
          changes.push({
            _tag: "Install",
            row,
            invocation: change.invocation,
            verification: change._tag === "Manage" ? change.verification : "write",
          });
          break;
        case "KeepDeleted":
          changes.push({ _tag: "Save", row, result: "Suppressed", backUp: false });
          break;
        case "Unchanged":
          changes.push({ _tag: "Save", row, result: "Unchanged", backUp: false });
          break;
        case "Conflict":
          changes.push({ _tag: "Save", row, result: "Conflicted", backUp: change.edited });
          break;
      }
      continue;
    }
    const row = change.recorded;
    const successors = plan.changes.filter(
      (other) =>
        "skillVersionId" in other &&
        other.skillId === row.skill_id &&
        other.destination === row.destination,
    );
    if (
      successors.length &&
      !successors.some((other) => "path" in other && rows.get(other.path)?.status === "installed")
    )
      continue;
    if (change._tag === "Conflict")
      changes.push({
        _tag: "Save",
        row: Status.conflicted(row, change.currentHash, change.conflicts),
        result: "Conflicted",
        backUp: false,
      });
    else
      changes.push({
        _tag: change._tag,
        id: row.installed_skill_id,
        keep:
          plan.intent._tag === "Uninstall" && !plan.intent.drop.includes(row.installed_skill_id),
      });
  }
  const { installed_skills: _rows, operations: _operations, ...next } = plan.next;
  return {
    _tag: "Apply",
    before: publication(before),
    next,
    routing,
    save: plan.intent._tag === "Remove" ? "after" : "before",
    enabled: plan.changes.flatMap((change) => {
      if (change._tag !== "Enable" && change._tag !== "Disable") return [];
      return [
        {
          change,
          skillIds: plan.next.skills
            .filter(
              (skill) =>
                (skill.skill_id === change.subject_id ||
                  skill.collection_id === change.subject_id) &&
                change.skills.includes(skill.name),
            )
            .map((skill) => skill.skill_id),
          targets: plan.routes.find((route) => same(route.scope, change.scope))?.destinations ?? [],
        },
      ];
    }),
    folders: plan.folders.map((folder) => ({
      ...folder,
      entry: folder.entry._tag === "Absent" ? "Absent" : folder.entry.kind,
    })),
    changes,
    phase: { _tag: "Pending" },
  } satisfies ApplyStep;
});

export const rowAfter = (
  step: ApplyStep,
  change: RecordedInstalledChange,
): InstalledSkill | undefined => {
  if (change._tag === "Install" || change._tag === "Save") return change.row;
  if (change._tag === "Fail") return undefined;
  const prior = step.before.installed_skills.find((row) => row.installed_skill_id === change.id);
  return change.keep && prior
    ? prior.status === "suppressed"
      ? prior
      : Status.pending(prior)
    : undefined;
};
export const finalRows = (step: ApplyStep) => {
  const rows = new Map(step.before.installed_skills.map((row) => [row.installed_skill_id, row]));
  for (const change of step.changes) {
    if (change._tag === "Fail") continue;
    const row = rowAfter(step, change);
    if (row) rows.set(row.installed_skill_id, row);
    else if (change._tag === "Uninstall" || change._tag === "Forget") rows.delete(change.id);
  }
  return [...rows.values()];
};
export const copiesOf = (step: ApplyStep): InstalledSkillResult[] =>
  step.changes.flatMap((change): InstalledSkillResult[] => {
    if (change._tag === "Install") return [{ _tag: "Installed", copy: change.row }];
    if (change._tag === "Save") return [{ _tag: change.result, copy: change.row }];
    if (change._tag === "Uninstall") {
      const copy = step.before.installed_skills.find((row) => row.installed_skill_id === change.id);
      return copy ? [{ _tag: "Uninstalled", copy }] : [];
    }
    return [];
  });
