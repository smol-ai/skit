import { Effect, Option } from "effect";
import { sha256Hash } from "../../../shared/hash.js";
import { normalizeLibraryManifest } from "../../manifest.js";
import { inspectContent } from "../content/content.js";
import { snapshotOf } from "../../snapshot.js";
import { canonicalJson } from "../../../shared/json.js";
import { inspectInstalledSkill } from "../../../installed-skills/files.js";
import * as InstalledSkillStatus from "../../installed-skill-status.js";
import * as InstalledSkills from "../../installed-skills.js";
import { operationScope } from "../operations/operations.js";
import { planIntent } from "../../plan-changes.js";
import { currentSkillVersion, enabledSkillIds } from "../../library-contracts.js";
import { InvalidIntent } from "../../enabled-plan.js";
import { LibraryState } from "../../library-state.js";
import { routedInstalledSkills } from "../../routing/recorded.js";
import { libraryOriginalsPath, libraryStatePath, loadLibrary } from "../../store/library-store.js";
import type { OperationId } from "../../entity-ids.js";
import {
  type RecordedSetupStep,
  type SetupStep,
  type SyncProgram,
  type SyncPublication,
} from "../../store/state-schema.js";

export interface SyncStepResult {
  readonly _tag: "Sync";
  readonly phase: "retire" | "publish" | "install";
  readonly installed: number;
  readonly uninstalled: number;
  readonly issues: readonly string[];
}

/** History is not part of a publication, or each Sync would recursively copy earlier operations. */
export const syncPublication = ({
  operations: _operations,
  ...state
}: LibraryState): SyncPublication => state;

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const body = ({ installed_skills: _copies, ...state }: SyncPublication) => state;

const programFor = (
  step: Extract<SetupStep, { readonly _tag: "Sync" }>,
  steps: readonly RecordedSetupStep[],
) => {
  if (step.phase === "retire") return Option.some(step.program);
  const source = steps[step.sourceStep]?.step;
  return source?._tag === "Sync" && source.phase === "retire"
    ? Option.some(source.program)
    : Option.none<SyncProgram>();
};

/** Accept only the captured file or an exact, independently verifiable effect of this program. */
const checkFolders = Effect.fn("Library.sync.checkRecordedFolders")(function* (
  program: SyncProgram,
  state: LibraryState,
  installing: boolean,
  home: string,
) {
  const files = yield* InstalledSkills.Service;
  for (const saved of program.folders) {
    const current = yield* files.inspect(saved.path);
    if (
      !same(saved.ancestors, current.ancestors) &&
      (!installing ||
        current.ancestors.some((ancestor) => {
          const prior = saved.ancestors.find((item) => item.path === ancestor.path);
          return (
            !prior ||
            (prior.evidence !== ancestor.evidence &&
              !(prior.evidence === "absent" && ancestor.evidence.startsWith("Directory:")))
          );
        }))
    )
      return yield* new InstalledSkills.Changed({ path: saved.path });
    if (saved.evidence === current.evidence) continue;
    const retired = program.retire.find((copy) => copy.path === saved.path);
    const row = state.installed_skills.find((copy) => copy.path === saved.path);
    if (
      retired &&
      current.entry._tag === "Absent" &&
      ((program.drop.includes(retired.installed_skill_id) && row === undefined) ||
        (row?.installed_skill_id === retired.installed_skill_id && row.status === "pending"))
    )
      continue;
    if (installing && row) {
      const skill = program.after.skills.find((item) => item.skill_id === row.skill_id);
      const selected = skill && currentSkillVersion(program.after, skill);
      const routed = program.routing.destinations.some(
        (destination) =>
          destination.destination === row.destination && destination.root === row.root,
      );
      if (routed && selected?.skill_version_id === row.skill_version_id) {
        if ((yield* inspectInstalledSkill(row)).kind === "intact") continue;
        if (current.entry._tag === "Absent") {
          if (saved.entry === "Absent" && row.status === "pending") continue;
          const backups = yield* files.backups.scan(row.root, row.installed_skill_id);
          let verified = false;
          for (const backup of backups)
            if (
              yield* files.backups.check(
                backup,
                { ...program.before, operations: [] },
                libraryOriginalsPath(home),
                row.installed_skill_id,
              )
            ) {
              verified = true;
              break;
            }
          if (verified) continue;
        }
      }
    }
    return yield* new InstalledSkills.Changed({ path: saved.path });
  }
});

/** The existing operation runner owns progress writes and turns divergence into Stopped. */
export const runSyncStep = Effect.fn("Library.sync.recordedStep")(function* (
  operationId: OperationId,
  index: number,
  steps: readonly RecordedSetupStep[],
  home: string,
) {
  const step = steps[index]?.step;
  if (step?._tag !== "Sync")
    return yield* new InvalidIntent({ detail: "Expected a recorded Sync step" });
  const found = programFor(step, steps);
  if (Option.isNone(found))
    return yield* new InvalidIntent({ detail: "Sync step has no recorded program" });
  const program = found.value;
  const files = yield* routedInstalledSkills(program.routing);
  return yield* Effect.gen(function* () {
    let current = yield* loadLibrary(home);
    if (Option.isSome(program.receipt)) {
      const receipt = program.receipt.value;
      const hash = yield* sha256Hash(
        new TextEncoder().encode(canonicalJson(normalizeLibraryManifest(receipt.base_manifest))),
      );
      if (hash !== program.manifestDigest || !same(receipt, program.after.sync_ancestry))
        return yield* new InstalledSkills.Changed({ path: libraryStatePath(home) });
    }
    const retained = yield* inspectContent(
      home,
      snapshotOf({ present: true, state: { ...program.after, operations: [] } }),
    );
    if (retained._tag === "Changed")
      return yield* new InstalledSkills.Changed({ path: libraryOriginalsPath(home) });
    const scope = yield* operationScope(operationId, index, program.routing);
    current = yield* loadLibrary(home);
    const publication = syncPublication(current);
    const expected = step.phase === "install" ? program.after : program.before;
    const alreadyPublished = same(publication, program.after);
    if (!same(body(publication), body(expected)) && !(step.phase !== "install" && alreadyPublished))
      return yield* new InstalledSkills.Changed({ path: libraryStatePath(home) });
    if (step.phase !== "install" && !alreadyPublished) {
      for (const copy of current.installed_skills) {
        const before = program.before.installed_skills.find(
          (item) => item.installed_skill_id === copy.installed_skill_id,
        );
        const retiring = program.retire.some(
          (item) => item.installed_skill_id === copy.installed_skill_id,
        );
        if (
          !before ||
          (!same(copy, before) && !(retiring && same(copy, InstalledSkillStatus.pending(before))))
        )
          return yield* new InstalledSkills.Changed({ path: copy.path });
      }
      for (const before of program.before.installed_skills)
        if (
          !current.installed_skills.some(
            (item) => item.installed_skill_id === before.installed_skill_id,
          ) &&
          !program.drop.includes(before.installed_skill_id)
        )
          return yield* new InstalledSkills.Changed({ path: before.path });
    }
    if (step.phase === "install") {
      for (const copy of current.installed_skills) {
        const expected = program.after.installed_skills.find((item) => item.path === copy.path);
        if (expected && same(copy, expected)) continue;
        const skill = program.after.skills.find((item) => item.skill_id === copy.skill_id);
        const selected = skill && currentSkillVersion(program.after, skill);
        const recordedPath = program.folders.some((item) => item.path === copy.path);
        const routed = program.routing.destinations.some(
          (item) => item.root === copy.root && item.destination === copy.destination,
        );
        if (
          !recordedPath ||
          !routed ||
          selected?.skill_version_id !== copy.skill_version_id ||
          (expected !== undefined && expected.installed_skill_id !== copy.installed_skill_id)
        )
          return yield* new InstalledSkills.Changed({ path: copy.path });
      }
      for (const copy of program.after.installed_skills)
        if (
          !current.installed_skills.some(
            (item) => item.installed_skill_id === copy.installed_skill_id,
          )
        )
          return yield* new InstalledSkills.Changed({ path: copy.path });
    }
    yield* checkFolders(program, current, step.phase === "install", home);
    let installed = 0;
    let uninstalled = 0;
    const issues = [...program.issues];
    if (step.phase === "retire" && !alreadyPublished) {
      const live = program.retire.filter((copy) =>
        current.installed_skills.some((row) => row.installed_skill_id === copy.installed_skill_id),
      );
      if (live.length) {
        const outcome = yield* scope.apply(
          "retire",
          yield* planIntent(
            {
              _tag: "Uninstall",
              copies: live.map((copy) => copy.installed_skill_id),
              drop: program.drop,
            },
            { home, base: snapshotOf({ present: true, state: current }) },
          ),
        );
        if (outcome._tag === "Incomplete") return yield* outcome.cause;
        uninstalled = outcome.copies.filter((copy) => copy._tag === "Uninstalled").length;
      }
    } else if (step.phase === "publish" && !alreadyPublished) {
      yield* scope.publishSync();
    } else if (step.phase === "install" && issues.length === 0) {
      const attempt = yield* Effect.result(
        Effect.gen(function* () {
          return yield* scope.apply(
            "install",
            yield* planIntent(
              { _tag: "Install" },
              { home, base: snapshotOf({ present: true, state: current }) },
            ),
          );
        }),
      );
      if (attempt._tag === "Failure") {
        if (attempt.failure instanceof InstalledSkills.Changed) return yield* attempt.failure;
        if (program.after.device_skill_selection?.mode !== "choose") return yield* attempt.failure;
        issues.push(`Enablement failed: ${String(attempt.failure)}`);
      } else if (attempt.success._tag === "Incomplete") {
        if (program.after.device_skill_selection?.mode !== "choose")
          return yield* attempt.success.cause;
        issues.push(`Enablement failed: ${String(attempt.success.cause)}`);
      } else {
        installed = attempt.success.copies.filter((copy) => copy._tag === "Installed").length;
        uninstalled = attempt.success.copies.filter((copy) => copy._tag === "Uninstalled").length;
        if (program.after.device_skill_selection?.mode === "choose") {
          const selected = new Set(
            enabledSkillIds(program.after, program.after.device_skill_selection.enabled),
          );
          for (const copy of (yield* loadLibrary(home)).installed_skills.filter(
            (copy) =>
              copy.status === "conflicted" &&
              selected.has(copy.skill_id) &&
              program.routing.active.includes(copy.destination),
          ))
            issues.push(
              `Cannot install at ${copy.path}: existing content or ownership conflicts. Preserve it and review before retrying.`,
            );
        }
      }
    }
    return {
      _tag: "Ran" as const,
      result: {
        _tag: "Sync" as const,
        phase: step.phase,
        installed,
        uninstalled,
        issues,
      } satisfies SyncStepResult,
      after: [],
    };
  }).pipe(
    Effect.provideService(InstalledSkills.Service, files),
    Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
      Effect.succeed({
        _tag: "Stop" as const,
        reason: {
          _tag: "EvidenceDiffers" as const,
          step: index,
          path: error.path,
          expected: { before: Option.none(), after: Option.none() },
        },
      }),
    ),
  );
});
