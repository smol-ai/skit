import { Revision, type Snapshot } from "../../snapshot.js";
import { Effect, Option, Schema, Struct } from "effect";
import { join } from "node:path";
import { FailureTypeId, type SkitFailure } from "../../../shared/failure.js";
import { Hash } from "../../../shared/hash.js";
import { leavePnpmSkill } from "../../../installed-skills/pnpm-skills.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { makeOperationId, OperationId } from "../../entity-ids.js";
import { holdsEvidence, parentIsAsRecorded } from "../../folder-evidence.js";
import type { ImportedCollection } from "../../import-collection.js";
import { InstalledSkills } from "../../installed-skills.js";
import { planManage } from "../../manage-plan.js";
import { Plan, StalePlan } from "../../library-plan.js";
import { planManageEnable, duplicatesToMove, installedPaths } from "../../setup-manage.js";
import { recoveryDirectory } from "../../setup-moves.js";
import { setupOperation, checkSteps } from "../../setup.js";

import { applyReviewed, planIdOf, planningState } from "../../reviewed-plan.js";
import {
  FolderEvidence,
  LinkEvidence,
  ManageExistingSelection,
  ManageNewSelection,
  ManageStepSource,
  SetupStep,
  SetupStopReason,
  StepRouting,
} from "../../store/state-schema.js";
import { SetEnabledResult } from "../session/set-enabled-contract.js";

const NewSelection = ManageNewSelection.mapFields(
  Struct.assign({
    importFrom: Schema.Union([ManageStepSource.cases.Import, ManageStepSource.cases.Collection]),
  }),
);
export const ManageIntent = Schema.Union([
  Schema.TaggedStruct("Manage", {
    mode: Schema.Literal("existing"),
    selections: Schema.Array(ManageExistingSelection),
  }),
  Schema.TaggedStruct("Manage", {
    mode: Schema.Literal("new"),
    selections: Schema.Array(NewSelection),
  }),
]);
export type ManageIntent = typeof ManageIntent.Type;
const SelectionChange = Schema.Struct({
  name: Schema.String,
  sourcePath: Schema.String,
  mode: Schema.Literals(["existing", "new"]),
  currentHash: Hash,
  equalCopies: Schema.Array(FolderEvidence),
  duplicateAction: Schema.Literals([
    "keep-both",
    "preserve-duplicates",
    "retire-aliases",
    "retain-only",
  ]),
  approvedSymlinks: Schema.Array(LinkEvidence),
  approvedCopies: Schema.Array(FolderEvidence),
  // Validate known plan fields without stripping future Library state inside an enable preview.
  enable: Schema.OptionFromOptionalKey(Schema.Unknown.pipe(Schema.refine(Schema.is(Plan)))),
  backup: Schema.OptionFromOptionalKey(
    Schema.Struct({
      recoveryDirectory: Schema.String,
      entries: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.String,
          type: Schema.Literals(["Directory", "SymbolicLink"]),
        }),
      ),
    }),
  ),
});
const Change = Schema.Struct({
  mode: Schema.Literals(["existing", "new"]),
  selections: Schema.Array(SelectionChange),
});
export const ManageChange = Change.pipe(Schema.fieldsAssign({ planId: Hash }));
const Reviewed = Schema.TaggedStruct("Manage", {
  intent: ManageIntent,
  home: Schema.String,
  baseRevision: Revision,
  operationId: OperationId,
  routing: StepRouting,
  change: Change,
  steps: Schema.Array(SetupStep),
  folders: Schema.Array(InstalledSkills.Folder),
});
export const ManagePlan = Reviewed.pipe(
  Schema.fieldsAssign({ planId: Hash, change: ManageChange }),
);
export type ManagePlan = typeof ManagePlan.Type;
export interface ManageResult {
  readonly results: readonly SetEnabledResult[];
  readonly imported: readonly ImportedCollection[];
  readonly recoveryDirectories: readonly string[];
  readonly warnings: readonly { readonly name: string; readonly message: string }[];
}
export interface ManageOutcome {
  readonly _tag: "Manage";
  readonly result: ManageResult;
}
/** Work already recorded is visible by operationId; failure never implies rollback. */
export class ManageStopped
  extends Schema.TaggedError<ManageStopped>()("Library.ManageStopped", {
    operationId: OperationId,
    reason: SetupStopReason,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  get message() {
    return `Manage stopped after recording operation ${this.operationId}. No changes were rolled back.`;
  }
  get remediation() {
    return `Inspect Library history and preview undoing operation ${this.operationId}, or review a new setup.`;
  }
}
const checkEvidence = Effect.fn("Library.checkManageEvidence")(function* (intent: ManageIntent) {
  const selected = new Set<string>();
  for (const selection of intent.selections) {
    const key =
      intent.mode === "existing" ? selection.name : `${selection.name}\0${selection.source.path}`;
    if (selected.has(key))
      return yield* new InvalidIntent({ detail: `Duplicate Manage selection: ${selection.name}` });
    selected.add(key);
    if (
      selection.mode === "existing"
        ? selection.currentHash !== selection.source.treeHash
        : Option.isSome(selection.currentHash) &&
          selection.currentHash.value !== selection.source.treeHash
    )
      return yield* new StalePlan({ message: `Reviewed content changed for ${selection.name}` });
    const folders = [
      selection.source,
      ...selection.approvedCopies,
      ...selection.approvedSymlinks,
      ...(selection.mode === "new" ? selection.equalCopies : []),
    ];
    for (const folder of folders) {
      yield* leavePnpmSkill(folder.path);
      if (
        !(yield* parentIsAsRecorded(folder.path, folder.parent)) ||
        !(yield* holdsEvidence(folder, folder.path))
      )
        return yield* new StalePlan({
          message: `Reviewed Manage folder changed at ${folder.path}`,
        });
    }
  }
});

export const checkedManageIntent = Effect.fn("Library.checkManageIntent")(function* (
  input: ManageIntent,
) {
  return yield* Schema.encodeEffect(ManageIntent, { onExcessProperty: "error" })(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ManageIntent)),
    Effect.mapError(() => new InvalidIntent({ detail: "Invalid Manage intent" })),
  );
});

export const planManaging = Effect.fn("Library.planManaging")(function* (
  home: string,
  input: ManageIntent,
  options: {
    readonly base: Snapshot;
    readonly routing: StepRouting;
    readonly operationId?: OperationId;
  },
) {
  const files = yield* InstalledSkills.Service;
  const intent = yield* checkedManageIntent(input);
  const state = yield* planningState(home, options.base);
  yield* checkEvidence(intent);
  const operationId = options.operationId ?? makeOperationId();
  const routing = structuredClone(options.routing);
  const steps: SetupStep[] = [];
  if (intent.mode === "existing")
    steps.push({ _tag: "Manage", mode: "existing", selections: intent.selections, routing });
  else {
    const selections: ManageNewSelection[] = [];
    for (const selection of intent.selections) {
      if (selection.importFrom._tag === "Import") {
        const step = steps.length;
        steps.push({ _tag: "Import", request: selection.importFrom.request });
        selections.push({ ...selection, importFrom: { _tag: "Step", step } });
      } else selections.push(selection);
    }
    steps.push({ _tag: "Manage", mode: "new", selections, routing });
  }
  const problem = checkSteps(home, steps);
  if (Option.isSome(problem)) return yield* new InvalidIntent({ detail: problem.value });
  const selections: (typeof SelectionChange.Type)[] = [];
  const paths = new Set<string>();
  for (const [index, selection] of intent.selections.entries()) {
    const installs =
      Option.getOrUndefined(selection.duplicates) !== "retain-only" &&
      (selection.mode === "existing" || Option.isSome(selection.ownership));
    let enable: Option.Option<Plan> = Option.none();
    if (selection.mode === "new" && installs && Option.isSome(selection.ownership)) {
      const ownership = selection.ownership.value;
      const managing = yield* planManage(
        ownership.harnesses.map((harness) => ({
          path: selection.source.path,
          harness,
          scope: { kind: "global" },
        })),
        selection.source.path,
        { base: state },
      );
      if (!managing.applicable || managing.skill?.name !== selection.name)
        return yield* new InvalidIntent({
          detail: `${selection.name} cannot be managed without changing its bytes`,
        });
      if (
        managing.targets.some((target) => target.status === "adoptable") &&
        Option.isNone(ownership.machineId)
      )
        return yield* new InvalidIntent({
          detail: `Managing ${selection.name} needs this machine's identity`,
        });
    }
    if (selection.mode === "existing" && installs)
      enable = Option.some(
        yield* planManageEnable(
          home,
          selection,
          selection.subjectId,
          { path: selection.source.path, equalPaths: [], currentHash: selection.currentHash },
          state,
        ),
      );
    for (const folder of [
      selection.source,
      ...selection.approvedCopies,
      ...selection.approvedSymlinks,
      ...(selection.mode === "new" ? selection.equalCopies : []),
    ])
      paths.add(folder.path);
    for (const path of installedPaths(routing, selection)) paths.add(path);
    if (selection.mode === "new" && selection.importFrom._tag === "Import")
      for (const skill of selection.importFrom.request.skills) paths.add(skill.sourcePath);
    const moving = installs ? duplicatesToMove(routing, selection) : [];
    selections.push({
      name: selection.name,
      sourcePath: selection.source.path,
      mode: selection.mode,
      currentHash: selection.source.treeHash,
      equalCopies: selection.mode === "new" ? selection.equalCopies : [],
      duplicateAction: Option.getOrElse(selection.duplicates, () => "keep-both" as const),
      approvedSymlinks: selection.approvedSymlinks,
      approvedCopies: selection.approvedCopies,
      enable,
      backup: moving.length
        ? Option.some({
            recoveryDirectory: recoveryDirectory(home, operationId, steps.length - 1, index),
            entries: moving.map((folder) => ({
              name: selection.name,
              path: folder.path,
              type: folder._tag,
            })),
          })
        : Option.none(),
    });
    // A new duplicate or root change alters the folder receipt, even before its subject is imported.
    if (installs) {
      const duplicates = yield* files.duplicates.scan({ kind: "global" }, [selection.name]);
      for (const root of duplicates.roots) paths.add(join(root, selection.name));
      for (const copy of duplicates.copies) {
        paths.add(copy.canonicalPath);
        for (const alias of copy.aliases) paths.add(alias.path);
      }
    }
  }
  const reviewed: typeof Reviewed.Type = {
    _tag: "Manage",
    intent,
    home,
    baseRevision: options.base.revision,
    operationId,
    routing,
    change: { mode: intent.mode, selections },
    steps,
    folders: yield* Effect.forEach([...paths].sort(), (path) => files.inspect(path)),
  };
  const encoded = yield* Schema.encodeEffect(Reviewed)(reviewed).pipe(
    Effect.mapError(() => new InvalidIntent({ detail: "Invalid Manage review" })),
  );
  const planId = yield* planIdOf(encoded);
  return { ...reviewed, planId, change: { ...reviewed.change, planId } } satisfies ManagePlan;
});

export const applyManaging = Effect.fn("Library.applyManaging")(function* (
  home: string,
  input: ManagePlan,
) {
  const files = yield* InstalledSkills.Service;
  const plan = yield* Schema.encodeEffect(ManagePlan, { onExcessProperty: "error" })(input).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ManagePlan)),
    Effect.mapError(() => new StalePlan({ message: "Invalid Manage plan" })),
  );
  return yield* applyReviewed(
    home,
    plan,
    // The reviewed folders are checked before planning again observes them.
    (base) =>
      files.check(plan.folders).pipe(
        Effect.catchTag("Library.InstalledSkillsChanged", () =>
          Effect.fail(new StalePlan({ message: "Reviewed Manage folders changed" })),
        ),
        Effect.andThen(
          planManaging(home, plan.intent, {
            base,
            routing: plan.routing,
            operationId: plan.operationId,
          }),
        ),
      ),
    (again, base) =>
      Effect.gen(function* () {
        const applied = yield* setupOperation(again.steps, {
          base,
          operationId: again.operationId,
        });
        if (applied._tag === "Stopped")
          return yield* new ManageStopped({
            operationId: applied.operationId,
            reason: applied.reason,
          });
        return {
          _tag: "Manage",
          result: {
            results: applied.steps.flatMap((step) => (step._tag === "Manage" ? step.results : [])),
            imported: applied.steps.flatMap((step) =>
              step._tag === "Import" ? [step.imported] : [],
            ),
            recoveryDirectories: applied.recoveryDirectories,
            warnings: applied.warnings,
          },
        } satisfies ManageOutcome;
      }),
  );
});
export type ManagePlanError = Effect.Error<ReturnType<typeof planManaging>>;
export type ManageApplyError = Effect.Error<ReturnType<typeof applyManaging>>;
