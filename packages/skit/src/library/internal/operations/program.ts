import { Effect, Schema } from "effect";
import { canonicalJson } from "../../../shared/json.js";
import { InvalidLibraryState } from "../../failures.js";
import { libraryStatePath } from "../../store/library-store.js";
import type { Plan, InstalledSkillResult } from "../../library-plan.js";
import type { InstalledSkill } from "../../device-state.js";
import { decodeLibraryState, prepareLibrarySets, type LibraryState } from "../../library-state.js";
import { sha256Hash } from "../../../shared/hash.js";
import { edit } from "../../library-edit.js";
import * as Status from "../../installed-skill-status.js";
import type {
  InstalledApply,
  RecordedInstalledChange,
  StepRouting,
} from "../../store/state-schema.js";

export type ApplyStep = InstalledApply;
export const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const body = (value: LibraryState) => {
  const { installed_skills: _rows, ...state } = prepareLibrarySets(value);
  return state;
};

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
  const beforeHash = yield* hashBody(before);
  const afterHash = yield* hashBody(plan.next);
  let bodyChange: ApplyStep["bodyChange"];
  if (plan.intent._tag === "Remove")
    bodyChange = { _tag: "Remove", collectionId: plan.intent.collectionId };
  else if (plan.intent._tag === "Enabled") {
    const oldFields = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(body(before)).pipe(
      Effect.mapError(
        (failure) =>
          new InvalidLibraryState({
            path: libraryStatePath(home),
            reason: { _tag: "SchemaInvalid", failure },
          }),
      ),
    );
    const newFields = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(body(plan.next)).pipe(
      Effect.mapError(
        (failure) =>
          new InvalidLibraryState({
            path: libraryStatePath(home),
            reason: { _tag: "SchemaInvalid", failure },
          }),
      ),
    );
    const fields = [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])]
      .filter(
        (field) =>
          !same(oldFields[field], newFields[field]) ||
          Object.hasOwn(oldFields, field) !== Object.hasOwn(newFields, field),
      )
      .map((field) => ({
        field,
        ...(Object.hasOwn(oldFields, field) ? { before: oldFields[field] } : {}),
        ...(Object.hasOwn(newFields, field) ? { after: newFields[field] } : {}),
      }));
    if (
      fields.some(({ field }) =>
        ["collections", "skills", "collection_versions", "imports", "sync_ancestry"].includes(
          field,
        ),
      )
    )
      return yield* new InvalidLibraryState({
        path: libraryStatePath(home),
        reason: { _tag: "InvalidData" },
      });
    bodyChange = { _tag: "Enabled", fields };
  } else if (beforeHash !== afterHash)
    return yield* new InvalidLibraryState({
      path: libraryStatePath(home),
      reason: { _tag: "InvalidData" },
    });
  return {
    _tag: "Apply",
    beforeHash,
    afterHash,
    previousInstalledSkills: before.installed_skills,
    ...(bodyChange === undefined ? {} : { bodyChange }),
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
  const prior = step.previousInstalledSkills.find((row) => row.installed_skill_id === change.id);
  return change.keep && prior
    ? prior.status === "suppressed"
      ? prior
      : Status.pending(prior)
    : undefined;
};
export const finalRows = (step: ApplyStep) => {
  const rows = new Map(step.previousInstalledSkills.map((row) => [row.installed_skill_id, row]));
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
      const copy = step.previousInstalledSkills.find((row) => row.installed_skill_id === change.id);
      return copy ? [{ _tag: "Uninstalled", copy }] : [];
    }
    return [];
  });

/** Installed-row progress never changes the accepted Library body identities. */
export const hashBody = (state: LibraryState) =>
  sha256Hash(new TextEncoder().encode(canonicalJson(body(state))));

/** Restore only recorded field changes; preserve every other live field, including extensions. */
export const prepareApplyFields = Effect.fn("Library.prepareApplyFields")(function* (
  step: ApplyStep,
  current: LibraryState,
  side: "before" | "after",
  home: string,
) {
  const document = {
    ...current,
    installed_skills: [],
  };
  if (step.bodyChange?._tag === "Enabled")
    for (const field of step.bodyChange.fields) {
      if (Object.hasOwn(field, side))
        Object.defineProperty(document, field.field, {
          value: field[side],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else Reflect.deleteProperty(document, field.field);
    }
  const state = yield* decodeLibraryState(document).pipe(
    Effect.mapError(
      (failure) =>
        new InvalidLibraryState({
          path: libraryStatePath(home),
          reason: { _tag: "SchemaInvalid", failure },
        }),
    ),
  );
  // These rows are the recorded expectation, not a publication. Save/check retain ownership
  // of row validity; a refused plan may still contain colliding desired rows.
  return {
    ...state,
    installed_skills: side === "before" ? [...step.previousInstalledSkills] : finalRows(step),
  };
});

/** A reconstructed body is usable only after its recorded identity has been verified. */
export const prepareApplyState = Effect.fn("Library.prepareApplyState")(function* (
  step: ApplyStep,
  current: LibraryState,
  side: "before" | "after",
  home: string,
) {
  let source = current;
  if (
    side === "after" &&
    step.bodyChange?._tag === "Remove" &&
    (yield* hashBody(current)) !== step.afterHash
  )
    source = (yield* edit(current, { _tag: "Remove", collectionId: step.bodyChange.collectionId }))
      .next;
  const restored = yield* prepareApplyFields(step, source, side, home);
  if ((yield* hashBody(restored)) !== (side === "before" ? step.beforeHash : step.afterHash))
    return yield* new InvalidLibraryState({
      path: libraryStatePath(home),
      reason: { _tag: "InvalidData" },
    });
  return restored;
});
