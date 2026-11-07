import { join } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import * as InstalledSkills from "../../installed-skills.js";
import { inspectLocalLibraryState } from "../../store/library-store.js";
import { emptyLibraryState } from "../../library-state.js";
import { Revision, snapshotOf } from "../../snapshot.js";
import type { Request } from "../../enabled-plan.js";
import { InstallScope } from "../../scope.js";
import { UninstallConflict } from "../../../installed-skills/failures.js";
import {
  InstalledSkillWouldDuplicate,
  InstalledSkillWouldReplaceLink,
  Plan,
  Route,
  StalePlan,
  type EnabledChange,
} from "../../library-plan.js";
import { planChanges, type PlannedChanges } from "../../plan-changes.js";
import type { LibraryState } from "../../library-state.js";
import type { Snapshot } from "../../snapshot.js";
import type { Scope } from "effect";
import type { PlanError } from "../../library-plan.js";

/** Policy: refuse a duplicate the request did not allow, or a link SKIT's copy would replace. */
const refuseDuplicates = Effect.fn("Library.refuseDuplicates")(function* (
  request: Request,
  change: EnabledChange,
  targets: readonly InstalledSkills.Destination[],
) {
  if (!request.enabled || change.duplicates === undefined) return;
  if (!request.allowDuplicate) {
    const files = yield* InstalledSkills.Service;
    // Setup consent covers only these exact links, while they are still the links reviewed.
    const remaining: InstalledSkills.Duplicate[] = [];
    for (const duplicate of change.duplicates) {
      const aliases = [];
      for (const alias of duplicate.aliases) {
        const reviewed = request.setup?.approvedSymlinks.find(
          (item) => item.path === alias.path && item.canonicalPath === duplicate.canonicalPath,
        );
        if (reviewed !== undefined) {
          const entry = (yield* files.inspect(alias.path)).entry;
          if (
            entry._tag === "Present" &&
            entry.kind === "SymbolicLink" &&
            entry.identity.dev === reviewed.dev &&
            entry.identity.ino === reviewed.ino &&
            entry.linkTarget === reviewed.linkTarget
          )
            continue;
        }
        aliases.push(alias);
      }
      if (aliases.length) remaining.push({ ...duplicate, aliases });
    }
    if (remaining.length) return yield* new InstalledSkillWouldDuplicate({ duplicates: remaining });
    return;
  }
  const paths = targets.flatMap((target) => change.skills.map((name) => join(target.root, name)));
  const links = change.duplicates.flatMap((copy) =>
    copy.aliases
      .filter(
        (alias) =>
          alias.via === "symlink" && alias.linkPath === alias.path && paths.includes(alias.path),
      )
      .map((alias) => alias.path),
  );
  if (links.length) return yield* new InstalledSkillWouldReplaceLink({ links });
});

export interface ReviewedApply {
  readonly input: Plan;
  readonly base: LibraryState;
  readonly again: PlannedChanges;
  readonly snapshot: Snapshot;
}
type ReviewApplyError =
  | StalePlan
  | UninstallConflict
  | PlanError
  | Effect.Error<ReturnType<typeof refuseDuplicates>>
  | Effect.Error<ReturnType<typeof inspectLocalLibraryState>>
  | Exclude<Effect.Error<ReturnType<InstalledSkills.Interface["check"]>>, InstalledSkills.Changed>;

/** Revalidate the reviewed intent and folders without creating roots or changing state. */
export const reviewApply = Effect.fn("Library.reviewApply")(function* (
  home: string,
  reviewed: Plan,
): Effect.fn.Return<
  ReviewedApply,
  ReviewApplyError,
  InstalledSkills.Service | FileSystem.FileSystem | Scope.Scope
> {
  const files = yield* InstalledSkills.Service;
  const input = structuredClone(reviewed);
  if (input._tag !== input.intent._tag)
    return yield* new StalePlan({ message: "The plan tag does not match its reviewed intent" });
  const stale = (message: string) => new StalePlan({ message });
  const inspected = yield* inspectLocalLibraryState(home);
  const base = inspected.present ? inspected.state : emptyLibraryState();
  const actual = snapshotOf(inspected).revision;
  if (actual !== input.baseRevision)
    return yield* new StalePlan({
      message: "Library changed after this change was previewed",
      expected: Revision.make(input.baseRevision),
      actual,
    });
  const again = yield* planChanges(home, base, input.intent, input.approvals);
  const targetsAt = (scope: InstallScope) =>
    again.routes.find((route) => Schema.toEquivalence(InstallScope)(route.scope, scope))
      ?.destinations ?? [];
  // A refusal by policy says more than "changed since preview", so it is checked first.
  for (const change of again.changes)
    if (change._tag === "Refuse") return yield* new UninstallConflict({ detail: change.detail });
  for (const { request, change } of again.enabled)
    yield* refuseDuplicates(request, change, targetsAt(request.scope));
  if (
    !Schema.toEquivalence(Schema.Array(Route))(again.routes, input.routes) ||
    !Schema.toEquivalence(Plan.cases.Update.fields.changes)(
      [...again.enabled.map(({ change }) => change), ...again.changes],
      input.changes,
    )
  )
    return yield* stale("Installed agent targets or paths changed after preview");
  yield* files
    .check(input.folders)
    .pipe(
      Effect.catchTag("Library.InstalledSkillsChanged", (error) =>
        Effect.fail(stale(error.message)),
      ),
    );

  return { input, base, again, snapshot: snapshotOf(inspected) };
});
