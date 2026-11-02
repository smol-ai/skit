import { Context, Data, Effect, Option, Schema, Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { Hash, InstallDestination, type InstallScope } from "../vocabulary.js";
import type { OwnershipMarker } from "../contracts.js";
import type { LibraryState } from "./library-state.js";
import type { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import {
  OwnershipMarkerInspection,
  type InstalledSkillMutationError,
  type reproducible,
} from "../install/files.js";
import type { InstalledSkillInvalid } from "./installation/install-enabled.js";
import type { installedSkillSource } from "./installation/installed-skill-source.js";
import type { InvocationIntent } from "../install/policy.js";
import type { SkitFailure } from "../shared/failure.js";
import { FailureTypeId } from "../shared/failure.js";
import type { TreeError } from "../shared/tree-error.js";

/**
 * Facts about this device's skill folders, and operations that carry out what Library decided.
 * It never sees a Library row and never decides policy.
 */

/** Entries are compared by device identity, never by path alone. */
export const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
export type Identity = typeof Identity.Type;
export const Destination = Schema.Struct({ destination: InstallDestination, root: Schema.String });
export type Destination = typeof Destination.Type;
export const Protection = Schema.Literals(["repository", "authored", "package-manager"]);
export type Protection = typeof Protection.Type;
/** What the installer reads at an existing folder, following a link as it always has. */
export const Facts = Schema.Struct({
  marker: OwnershipMarkerInspection,
  /** An empty or unhashable folder is a fact, never a planning failure. */
  hash: Schema.Union([
    Hash,
    Schema.Struct({ _tag: Schema.Literal("Unreadable"), reason: Schema.String }),
  ]),
  realPath: Schema.String,
  /** A `.git` at or above the folder: a checkout owns it. */
  insideRepository: Schema.Boolean,
  /** `.git` or `skit.remote.json` inside the folder. */
  holdsRepositoryFiles: Schema.Boolean,
  /**
   * Why the folder is someone else's in itself, so no Library plan touches it: a repository's
   * (`.git` or `skit.remote.json` inside it), an author's (`skit.json` or `.skit` inside it), or
   * pnpm's. A repository above the folder does not protect it. Null when it is not; plain data,
   * like the rest of an Observed, so it survives cloning into a plan.
   */
  protection: Schema.NullOr(Protection),
});
export type Facts = typeof Facts.Type;
export const Entry = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Absent") }),
  Schema.Struct({
    _tag: Schema.Literal("Present"),
    kind: Schema.Literals(["Directory", "SymbolicLink", "File", "Other"]),
    identity: Identity,
    /** Where a link points, when it points at something. */
    target: Schema.NullOr(Identity),
    /** A link's own text, as `readlink` reports it. */
    linkTarget: Schema.NullOr(Schema.String),
    /** Present when the entry, followed, is a directory. */
    facts: Schema.NullOr(Facts),
  }),
]);
export type Entry = typeof Entry.Type;
/** One path as seen when it was inspected. Plain data: it survives cloning into a plan. */
export const Observed = Schema.Struct({
  path: Schema.String,
  entry: Entry,
  /** Lossless evidence of everything in the entry, including what the hash leaves out. */
  evidence: Schema.String,
  ancestors: Schema.Array(Schema.Struct({ path: Schema.String, evidence: Schema.String })),
});
export type Observed = typeof Observed.Type;
/** A folder in recovery. */
export interface Backup {
  readonly path: string;
  readonly marker: OwnershipMarkerInspection;
}
/** What to build. Identity only: the build produces the hash, and so the marker. */
export interface Copy {
  /** The byte builder reads the real Library; a narrower input is a later change. */
  readonly state: LibraryState;
  readonly originalsPath: string;
  readonly installedSkillId: InstalledSkillId;
  readonly skillId: SkillId;
  readonly skillVersionId: SkillVersionId;
  readonly invocationIntent: InvocationIntent;
}
/** Built bytes in staging on the destination's own device. Lives as long as its Scope. */
export interface Staged {
  readonly copy: Copy;
  readonly destination: Destination;
  readonly path: string;
  readonly hash: Hash;
}
export interface Installed {
  readonly path: string;
  readonly hash: Hash;
  /** The predecessor this install moved to recovery, if there was one. */
  readonly replaced: Option.Option<Backup>;
}
export const Duplicate = Schema.Struct({
  name: Schema.String,
  harness: Schema.String,
  canonicalPath: Schema.String,
  aliases: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      via: Schema.Literals(["symlink", "directory", "unknown-root"]),
      linkPath: Schema.optionalKey(Schema.String),
      linkTarget: Schema.optionalKey(Schema.String),
    }),
  ),
  documentHash: Schema.String,
});
export type Duplicate = typeof Duplicate.Type;
export const Warning = Schema.Struct({ path: Schema.String, message: Schema.String });
export type Warning = typeof Warning.Type;

export type Cause =
  | InstalledSkillMutationError
  | TreeError
  | PlatformError
  | DuplicateScanIncomplete
  | InstalledSkillInvalid
  | Effect.Error<ReturnType<typeof installedSkillSource>>
  | Effect.Error<ReturnType<typeof reproducible>>;
export class Changed
  extends Data.TaggedError("Library.InstalledSkillsChanged")<{ readonly path: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Preview the Binding change again.";
  get message() {
    return `Installed skill evidence changed at ${this.path}`;
  }
}
export class DuplicateScanIncomplete
  extends Data.TaggedError("DuplicateScanIncomplete")<{
    path: string;
    message: string;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "CONFLICT" as const;
  readonly remediation = "Inspect the skills directory before enabling another copy.";
}

export interface Interface {
  /** Install destinations active on this device. Unknown routing counts every one as active. */
  readonly active: Effect.Effect<readonly InstallDestination[], Cause>;
  readonly destinations: (scope: InstallScope) => Effect.Effect<readonly Destination[], Cause>;
  /** A physical identity for a root, so a symlinked alias is the same root. Changes nothing. */
  readonly identify: (
    path: string,
  ) => Effect.Effect<{ readonly key: string; readonly canonicalPath: string }, Cause>;
  /** Changes nothing. */
  readonly inspect: (path: string) => Effect.Effect<Observed, Cause>;
  /** The hash an installed copy is decided and verified against. Changes nothing. */
  readonly hash: (path: string) => Effect.Effect<Hash, Cause>;
  /** Changes nothing: every path still matches what was observed. */
  readonly check: (observed: readonly Observed[]) => Effect.Effect<void, Changed | Cause>;
  /** Create roots and prove them writable, before the Library saves intent. */
  readonly prepare: (roots: readonly string[]) => Effect.Effect<void, Cause>;
  /** Build the bytes first, so Library can compare their hash with what is on disk. */
  readonly build: (
    copy: Copy,
    destination: Destination,
  ) => Effect.Effect<Staged, Cause, Scope.Scope>;
  /**
   * Into an absent path, or over an owned copy, which goes to recovery as pending. `recheck` runs
   * immediately before the commit. Every operation below does only what Library decided.
   */
  readonly install: (
    staged: Staged,
    marker: OwnershipMarker,
    recheck: Observed,
  ) => Effect.Effect<Installed, Cause>;
  /** Stamp SKIT's marker on a folder that already holds exactly the staged bytes. */
  readonly manage: (
    staged: Staged,
    marker: OwnershipMarker,
    recheck: Observed,
    verification: string,
  ) => Effect.Effect<Installed, Cause>;
  /** Copy an edited folder to `into`, once, and leave it in place. */
  readonly backUp: (path: string, into: string) => Effect.Effect<void, Cause>;
  /** Move the folder to recovery as a pending backup of `installedSkillId`. */
  readonly uninstall: (
    root: string,
    path: string,
    installedSkillId: InstalledSkillId,
  ) => Effect.Effect<Backup, Cause>;
  readonly duplicates: {
    /** Changes nothing. */
    readonly scan: (
      scope: InstallScope,
      names: readonly string[],
    ) => Effect.Effect<
      {
        readonly copies: readonly Duplicate[];
        readonly warnings: readonly Warning[];
        readonly roots: readonly string[];
      },
      Cause
    >;
  };
  readonly backups: {
    /** Pending backups of one installed skill. Changes nothing. */
    readonly scan: (
      root: string,
      installedSkillId: InstalledSkillId,
    ) => Effect.Effect<readonly Backup[], Cause>;
    /** Whether the backup is exactly what the loaded Library would build again. Changes nothing. */
    readonly check: (
      backup: Backup,
      state: LibraryState,
      originalsPath: string,
      installedSkillId: InstalledSkillId,
    ) => Effect.Effect<boolean, Cause>;
    readonly keep: (backup: Backup) => Effect.Effect<void, Cause>;
    readonly discard: (backup: Backup) => Effect.Effect<void, Cause>;
  };
}
export class Service extends Context.Service<Service, Interface>()(
  "skit/library/InstalledSkills",
) {}
export * as InstalledSkills from "./installed-skills.js";
