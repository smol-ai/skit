import { Effect, FileSystem, Schema } from "effect";
import { LinkStat } from "../../platform/link-stat.js";
import { leavePnpmSkill } from "../../installed-skills/pnpm-skills.js";
import { type DuplicateCopy } from "../duplicates.js";
import { StalePlan } from "../library-plan.js";
import { recordSetupCopies } from "./copy-backup.js";
import {
  duplicateSymlinksToBackUp,
  ApprovedSymlink,
  type SetupCopySelection,
  type SetupCopyConflict,
} from "./decisions.js";
import type { InventoryRootOptions } from "../routing/roots.js";

export interface ManageOptions {
  readonly installOptions: InventoryRootOptions;
}

/**
 * Check one selection's duplicate decision against the scan, and record the exact duplicate
 * copies or symlinks it approves. Setup checks every selection before managing any of them.
 */
export const checkManageSelection = Effect.fn("Manage.checkSelection")(function* <E>(
  selection: SetupCopySelection,
  conflict: SetupCopyConflict,
  invalid: (
    reason:
      | "duplicate-action-required"
      | "aliases-not-retirable"
      | "copies-not-preservable"
      | "keep-both-replaces-link",
  ) => E,
) {
  if (conflict.kind !== "none" && !selection.duplicateAction)
    return yield* Effect.fail(invalid("duplicate-action-required"));
  // A link at SKIT's destination is replaced by the copy, so the two cannot both stay.
  if (
    conflict.kind !== "none" &&
    conflict.replacesLink &&
    selection.duplicateAction === "keep-both"
  )
    return yield* Effect.fail(invalid("keep-both-replaces-link"));
  if (selection.duplicateAction === "preserve-duplicates") {
    if (conflict.kind !== "preservable")
      return yield* Effect.fail(invalid("copies-not-preservable"));
    return {
      ...selection,
      duplicateAction: selection.duplicateAction,
      approvedCopies: yield* recordSetupCopies(
        selection.sourcePath,
        conflict.duplicates,
        selection.approvedCopies,
      ),
    };
  }
  if (selection.duplicateAction !== "retire-aliases")
    return { ...selection, duplicateAction: selection.duplicateAction };
  if (conflict.kind !== "retirable")
    return yield* Effect.fail(
      selection.approvedSymlinks
        ? new StalePlan({ reason: { _tag: "ReviewedStateChanged" } })
        : invalid("aliases-not-retirable"),
    );
  return {
    ...selection,
    duplicateAction: selection.duplicateAction,
    approvedSymlinks: yield* recordDuplicateSymlinks(
      selection.sourcePath,
      conflict.duplicates,
      selection.approvedSymlinks,
    ),
  };
});

/** Bind observed symlinks to filesystem identities before approval, and verify that consent later. */
export const recordDuplicateSymlinks = Effect.fn("Manage.recordDuplicateSymlinks")(function* (
  sourcePath: string,
  duplicates: readonly DuplicateCopy[],
  approved?: readonly ApprovedSymlink[],
) {
  const paths = duplicateSymlinksToBackUp(sourcePath, duplicates);
  if (!paths.length) return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
  const links = yield* LinkStat;
  const fs = yield* FileSystem.FileSystem;
  const symlinks = yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      yield* leavePnpmSkill(path);
      const info = yield* links.identity.lstat(path);
      if (info.type !== "SymbolicLink")
        return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
      const canonicalPath = yield* fs.realPath(path);
      const linkTarget = yield* fs.readLink(path);
      if (
        canonicalPath !== sourcePath ||
        duplicates.some((duplicate) =>
          duplicate.aliases.some((alias) => alias.path === path && alias.linkTarget !== linkTarget),
        )
      )
        return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
      return { path, canonicalPath, linkTarget, dev: info.dev, ino: info.ino };
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          error.reason._tag === "NotFound"
            ? new StalePlan({ reason: { _tag: "ReviewedStateChanged" } })
            : error,
        ),
      ),
    ),
  );
  if (
    approved &&
    !Schema.toEquivalence(Schema.Array(ApprovedSymlink))(
      [...approved].sort((left, right) => left.path.localeCompare(right.path)),
      [...symlinks].sort((left, right) => left.path.localeCompare(right.path)),
    )
  )
    return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
  return symlinks;
});
