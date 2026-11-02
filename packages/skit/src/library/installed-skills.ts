import { Context, Data, Effect, Option, Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { InstallDestination, InstallScope, Hash } from "../vocabulary.js";
import type { OwnershipMarker } from "../contracts.js";
import type { LibraryState } from "./library-state.js";
import type { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import type {
  InstalledSkillMutationError,
  OwnershipMarkerInspection,
  reproducible,
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
export interface Identity {
  readonly dev: string;
  readonly ino: string;
}
export interface Destination {
  readonly destination: InstallDestination;
  readonly root: string;
}
/** What the installer reads at an existing folder, following a link as it always has. */
export interface Facts {
  readonly marker: OwnershipMarkerInspection;
  /** An empty or unhashable folder is a fact, never a planning failure. */
  readonly hash: Hash | { readonly _tag: "Unreadable"; readonly reason: string };
  readonly realPath: string;
  /** A `.git` at or above the folder: a checkout owns it. */
  readonly insideRepository: boolean;
  /** `.git` or `skit.remote.json` inside the folder. */
  readonly holdsRepositoryFiles: boolean;
  /**
   * Why the folder is someone else's in itself, so no Library plan touches it: a repository's
   * (`.git` or `skit.remote.json` inside it), an author's (`skit.json` or `.skit` inside it), or
   * pnpm's. A repository above the folder does not protect it. Null when it is not; plain data,
   * like the rest of an Observed, so it survives cloning into a plan.
   */
  readonly protection: Protection | null;
}
export type Protection = "repository" | "authored" | "package-manager";
export type Entry =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Present";
      readonly kind: "Directory" | "SymbolicLink" | "File" | "Other";
      readonly identity: Identity;
      /** Where a link points, when it points at something. */
      readonly target: Identity | null;
      /** A link's own text, as `readlink` reports it. */
      readonly linkTarget: string | null;
      /** Present when the entry, followed, is a directory. */
      readonly facts: Facts | null;
    };
/** One path as seen when it was inspected. Plain data: it survives cloning into a plan. */
export interface Observed {
  readonly path: string;
  readonly entry: Entry;
  /** Lossless evidence of everything in the entry, including what the hash leaves out. */
  readonly evidence: string;
  readonly ancestors: readonly { readonly path: string; readonly evidence: string }[];
}
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
export interface Duplicate {
  readonly name: string;
  readonly harness: string;
  readonly canonicalPath: string;
  readonly aliases: readonly {
    readonly path: string;
    readonly via: "symlink" | "directory" | "unknown-root";
    readonly linkPath?: string;
    readonly linkTarget?: string;
  }[];
  readonly documentHash: string;
}
export interface Warning {
  readonly path: string;
  readonly message: string;
}

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
/** An operation failed. `displaced` is the predecessor it had already moved to recovery, if any. */
export class Failed extends Data.TaggedError("Library.InstalledSkillsFailed")<{
  readonly path: string;
  readonly cause: Cause;
  readonly displaced: Option.Option<Backup>;
}> {}
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
  readonly active: Effect.Effect<readonly InstallDestination[], Failed>;
  readonly destinations: (scope: InstallScope) => Effect.Effect<readonly Destination[], Failed>;
  /** A physical identity for a root, so a symlinked alias is the same root. Changes nothing. */
  readonly identify: (
    path: string,
  ) => Effect.Effect<{ readonly key: string; readonly canonicalPath: string }, Failed>;
  /** Changes nothing. */
  readonly inspect: (path: string) => Effect.Effect<Observed, Failed>;
  /** The hash an installed copy is decided and verified against. Changes nothing. */
  readonly hash: (path: string) => Effect.Effect<Hash, Failed>;
  /** Changes nothing: every path still matches what was observed. */
  readonly check: (observed: readonly Observed[]) => Effect.Effect<void, Changed | Failed>;
  /** Create roots and prove them writable, before the Library saves intent. */
  readonly prepare: (roots: readonly string[]) => Effect.Effect<void, Failed>;
  /** Build the bytes first, so Library can compare their hash with what is on disk. */
  readonly build: (
    copy: Copy,
    destination: Destination,
  ) => Effect.Effect<Staged, Failed, Scope.Scope>;
  /**
   * Into an absent path, or over an owned copy, which goes to recovery as pending. `recheck` runs
   * immediately before the commit. Every operation below does only what Library decided.
   */
  readonly install: (
    staged: Staged,
    marker: OwnershipMarker,
    recheck: Observed,
  ) => Effect.Effect<Installed, Failed>;
  /** Stamp SKIT's marker on a folder that already holds exactly the staged bytes. */
  readonly manage: (
    staged: Staged,
    marker: OwnershipMarker,
    recheck: Observed,
    verification: string,
  ) => Effect.Effect<Installed, Failed>;
  /** Copy an edited folder to `into`, once, and leave it in place. */
  readonly backUp: (path: string, into: string) => Effect.Effect<void, Failed>;
  /** Move the folder to recovery as a pending backup of `installedSkillId`. */
  readonly uninstall: (
    root: string,
    path: string,
    installedSkillId: InstalledSkillId,
  ) => Effect.Effect<Backup, Failed>;
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
      Failed
    >;
  };
  readonly backups: {
    /** Pending backups of one installed skill. Changes nothing. */
    readonly scan: (
      root: string,
      installedSkillId: InstalledSkillId,
    ) => Effect.Effect<readonly Backup[], Failed>;
    /** Whether the backup is exactly what the loaded Library would build again. Changes nothing. */
    readonly check: (
      backup: Backup,
      state: LibraryState,
      originalsPath: string,
      installedSkillId: InstalledSkillId,
    ) => Effect.Effect<boolean, Failed>;
    readonly keep: (backup: Backup) => Effect.Effect<void, Failed>;
    readonly discard: (backup: Backup) => Effect.Effect<void, Failed>;
  };
}
export class Service extends Context.Service<Service, Interface>()(
  "skit/library/InstalledSkills",
) {}
export * as InstalledSkills from "./installed-skills.js";
