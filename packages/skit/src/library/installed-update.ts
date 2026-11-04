import { Effect, Schema } from "effect";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
import { canonicalJson } from "../shared/json.js";
import { apply } from "./apply-plan.js";
import type { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import type { Hash, InstallDestination } from "../vocabulary.js";
import { importEdit } from "./import-collection.js";
import { reviewInstalledSkillChanges } from "./installed-skill-review.js";
import { emptyLibraryState } from "./library-state.js";
import type { Approval } from "./library-plan.js";
import { planIntent } from "./plan-changes.js";
import { LibraryWriter, loadLibrary, inspectLocalLibraryState } from "./store/library-store.js";

/** A change to one installed copy, as reviewed: what updating every copy would do there. */
export interface ReviewedChange {
  readonly installedSkillId?: InstalledSkillId;
  readonly skillId: SkillId;
  readonly name: string;
  readonly path: string;
  readonly destination: InstallDestination;
  readonly baselineHash?: Hash;
  readonly currentHash?: Hash;
  readonly desiredHash?: Hash;
  readonly desiredVersionId?: SkillVersionId;
  readonly evidence: Hash;
  readonly status:
    | "unchanged"
    | "incoming-update"
    | "local-only"
    | "competing"
    | "protected"
    | "native-delete"
    | "uninstall"
    | "install";
  readonly metadataChanged: boolean;
  readonly reason?: string;
}

/** Which Version a competing Skill keeps: the retained one, or the copy at `path`. */
export interface UpdateChoice {
  readonly skillId: SkillId;
  readonly version: "retained" | "local";
  readonly path?: string;
}

/** What updating did to one reviewed copy. */
export interface UpdatedCopy {
  readonly installedSkillId?: InstalledSkillId;
  readonly name: string;
  readonly path: string;
  readonly status:
    | "installed"
    | "updated"
    | "unchanged"
    | "local-kept"
    | "native-delete"
    | "pending"
    | "uninstalled";
}

/** An update would write something other than the change reviewed at `path`. */
export class ReviewedChangeDiffers
  extends Schema.TaggedError<ReviewedChangeDiffers>()("Library.ReviewedChangeDiffers", {
    path: Schema.String,
  })
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the change again.";
  get message() {
    return `The installed skill at ${this.path} changed after it was reviewed`;
  }
}

/** Whether applying would write a copy or a record: what setup asks before touching any. */
export const changeWrites = (fact: Pick<ReviewedChange, "status" | "metadataChanged">) =>
  fact.status === "incoming-update" ||
  fact.status === "install" ||
  fact.status === "uninstall" ||
  fact.metadataChanged;

/**
 * Apply reviewed changes to existing copies: each local choice becomes its Skill's Version, then
 * one update installs what was reviewed. `reviewed` is every change the review showed; anything
 * the update would write must still be exactly that, so a copy already updated, which no longer
 * writes, is accepted as it is. A local choice already imported at `importedAt` is not imported
 * again, so running this twice imports each edit once.
 */
export const updateInstalledSkills = Effect.fn("Library.updateInstalledSkills")(function* (
  reviewed: readonly ReviewedChange[],
  choices: readonly UpdateChoice[],
  importedAt: string,
) {
  const writer = yield* LibraryWriter;
  const chosen = new Set<string>(choices.map((choice) => choice.skillId));
  const local = reviewed.filter((fact) =>
    choices.some(
      (choice) =>
        choice.version === "local" && choice.skillId === fact.skillId && choice.path === fact.path,
    ),
  );
  for (const fact of local) {
    if (fact.currentHash === undefined || fact.installedSkillId === undefined)
      return yield* new ReviewedChangeDiffers({ path: fact.path });
    const before = yield* loadLibrary(writer.home);
    if (
      before.imports.some(
        (sourceImport) =>
          sourceImport.kind === "edit" &&
          sourceImport.input.value === fact.path &&
          sourceImport.imported_at === importedAt,
      )
    )
      continue;
    yield* importEdit({
      skillId: fact.skillId,
      installedSkillId: fact.installedSkillId,
      path: fact.path,
      currentHash: fact.currentHash,
      importedAt,
    });
  }
  const inspected = yield* inspectLocalLibraryState(writer.home);
  const state = inspected.present ? inspected.state : emptyLibraryState();
  const planned = yield* planIntent({ _tag: "Update" }, { home: writer.home, base: state });
  const marker = (path: string) => {
    const entry = planned.folders.find((folder) => folder.path === path)?.entry;
    return entry?._tag === "Present" && entry.facts?.marker.kind === "valid"
      ? entry.facts.marker.marker
      : undefined;
  };
  // An edit that already is the Version keeps its folder; a chosen Version replaces every other
  // reviewed edit of its Skill, which goes to recovery and is kept there.
  const approvals = planned.changes.flatMap((change): Approval[] => {
    if (
      change._tag !== "Conflict" ||
      !("edited" in change) ||
      !change.edited ||
      change.recorded === undefined
    )
      return [];
    const installedSkillId = change.recorded.installed_skill_id;
    if (reviewed.find((fact) => fact.path === change.path)?.currentHash !== change.currentHash)
      return [];
    const current = marker(change.path);
    const accept: Approval[] =
      current === undefined ||
      (change.currentHash !== change.hash && !local.some((fact) => fact.path === change.path))
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
  const plan = yield* planIntent({ _tag: "Update" }, { home: writer.home, base: state, approvals });
  const facts = reviewInstalledSkillChanges(plan);

  // Outside the chosen Skills, each copy is as reviewed, or (after an earlier run) already the
  // update it was reviewed for; nothing writes that was not reviewed.
  // A change's reason is text the review derives from its status; a setup record does not keep it.
  const withoutReason = (change: ReviewedChange | undefined) =>
    change === undefined ? null : { ...change, reason: undefined };
  for (const fact of facts) {
    if (chosen.has(fact.skillId)) continue;
    const before = reviewed.find((item) => item.path === fact.path);
    const asReviewed = canonicalJson(withoutReason(fact)) === canonicalJson(withoutReason(before));
    const alreadyUpdated =
      before !== undefined &&
      changeWrites(before) &&
      fact.status === "unchanged" &&
      !fact.metadataChanged;
    const unreviewedAndIdle = before === undefined && !changeWrites(fact);
    if (!asReviewed && !alreadyUpdated && !unreviewedAndIdle)
      return yield* new ReviewedChangeDiffers({ path: fact.path });
  }
  // A chosen copy that the update would still leave edited was not the copy reviewed.
  for (const fact of facts)
    if (chosen.has(fact.skillId) && (fact.status === "competing" || fact.status === "local-only"))
      return yield* new ReviewedChangeDiffers({ path: fact.path });

  const outcome = yield* apply(plan);
  const copies = outcome._tag === "Applied" ? outcome.copies : [];
  return facts.map((fact): UpdatedCopy => {
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
