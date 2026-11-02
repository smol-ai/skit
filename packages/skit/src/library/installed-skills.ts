import type { PlatformError } from "effect/PlatformError";
import { dirname, join, resolve } from "node:path";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Scope } from "effect";
import { Digest } from "effect/crypto";
import * as InstalledSkillFiles from "../install/files.js";
import * as InstalledSkillBackups from "../install/backups.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { installedSkillSource } from "./installation/installed-skill-source.js";
import { LinkStat } from "../platform/link-stat.js";
import { SourceProcess } from "../platform/source-process.js";
import { TreeHasher } from "../artifact/tree-hasher.js";
import { deterministicTreeHash } from "../artifact/skit.js";
import { ensureSkillsDirectoryWritable } from "../install/writable.js";
import { installDestinationPathIdentity } from "../platform/path-identity.js";
import { sha256Hash } from "../shared/hash.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { OwnershipMarker } from "../contracts.js";
import type { InstallDestination, InstallScope, Hash } from "../vocabulary.js";
import type { LibraryState } from "./library-state.js";
import type { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import type {
  InstalledSkillMutationError,
  OwnershipMarkerInspection,
  reproducible,
} from "../install/files.js";
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
}
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

/** Where this machine installs: its active destinations, and copies Harnesses already read. */
export interface Routing {
  readonly active: Interface["active"];
  readonly destinations: Interface["destinations"];
  readonly duplicates: Interface["duplicates"];
}

/**
 * This device's skill folders. Without this machine's routing, its install destinations are
 * unknown rather than inactive: anything that needs them fails, and nothing is uninstalled for it.
 */
export const make = Effect.fn("InstalledSkills.make")(function* (routing?: Routing) {
  const unrouted = () =>
    Effect.fail(
      new Failed({
        path: "",
        cause: new InstalledSkillInvalid({
          detail: "This device's install destinations are unknown",
        }),
        displaced: Option.none(),
      }),
    );
  const context = (yield* Effect.context<TreeRequirements | TreeHasher | Digest.Digest>()).pipe(
    Context.pick(
      FileSystem.FileSystem,
      Path.Path,
      LinkStat,
      SourceProcess,
      TreeHasher,
      Digest.Digest,
    ),
  );
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const hasher = yield* TreeHasher;
  const failed =
    (path: string, displaced: Option.Option<Backup> = Option.none()) =>
    (cause: Cause) =>
      new Failed({ path, cause, displaced });

  /** The entry's own identity, and where a link points. Never follows a link to inspect it. */
  const identity = Effect.fn("InstalledSkills.identity")(function* (path: string) {
    return yield* links.identity.lstat(path).pipe(
      Effect.flatMap((info) =>
        info.type === "SymbolicLink"
          ? links.identity.stat(path).pipe(
              Effect.map(
                (target) =>
                  `${info.type}:${info.dev}:${info.ino}->${target.type}:${target.dev}:${target.ino}`,
              ),
              Effect.catchReason("PlatformError", "NotFound", () =>
                Effect.succeed(`${info.type}:${info.dev}:${info.ino}->absent`),
              ),
            )
          : Effect.succeed(`${info.type}:${info.dev}:${info.ino}`),
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("absent")),
    );
  });
  // Includes entries normalized hashes omit, and observes links without following them.
  const tree = Effect.fn("InstalledSkills.tree")(function* (
    path: string,
  ): Effect.fn.Return<string, PlatformError> {
    const entry = yield* identity(path);
    if (entry === "absent") return entry;
    const info = yield* links.lstat(path);
    if (info.type === "SymbolicLink") return JSON.stringify([entry, yield* fs.readLink(path)]);
    if (info.type === "File")
      return JSON.stringify([
        entry,
        info.mode,
        yield* sha256Hash(yield* fs.readFile(path)).pipe(Effect.provide(context)),
      ]);
    if (info.type !== "Directory") return entry;
    const children = yield* Effect.forEach((yield* fs.readDirectory(path)).sort(), (name) =>
      Effect.map(tree(join(path, name)), (value) => [name, value]),
    );
    return JSON.stringify([entry, info.mode, children]);
  });

  /** What the installer reads at a folder, following a link as it always has. */
  const facts = Effect.fn("InstalledSkills.facts")(function* (path: string) {
    const realPath = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
    let insideRepository = false;
    for (let directory = realPath; ; directory = dirname(directory)) {
      if (yield* fs.exists(join(directory, ".git"))) {
        insideRepository = true;
        break;
      }
      if (dirname(directory) === directory) break;
    }
    return {
      marker: yield* InstalledSkillFiles.inspectOwnershipMarker(path),
      hash: yield* deterministicTreeHash(path).pipe(
        Effect.map((hash): Facts["hash"] => hash),
        Effect.catchTag("TreeError", (error) =>
          Effect.succeed({ _tag: "Unreadable" as const, reason: error.reason._tag }),
        ),
      ),
      realPath,
      insideRepository,
      holdsRepositoryFiles:
        (yield* fs.exists(join(path, ".git"))) ||
        (yield* fs.exists(join(path, "skit.remote.json"))),
    } satisfies Facts;
  });

  const inspect = Effect.fn("InstalledSkills.inspect")(function* (path: string) {
    const absolute = resolve(path);
    const info = yield* links.identity
      .lstat(absolute)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
    const ancestors: { path: string; evidence: string }[] = [];
    for (let parent = dirname(absolute); ; parent = dirname(parent)) {
      ancestors.push({ path: parent, evidence: yield* identity(parent) });
      if (parent === dirname(parent)) break;
    }
    if (info === undefined)
      return {
        path: absolute,
        entry: { _tag: "Absent" },
        evidence: "absent",
        ancestors,
      } satisfies Observed;
    const followed = yield* links.identity
      .stat(absolute)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)));
    const kind =
      info.type === "Directory" || info.type === "SymbolicLink" || info.type === "File"
        ? info.type
        : "Other";
    return {
      path: absolute,
      entry: {
        _tag: "Present",
        kind,
        identity: { dev: String(info.dev), ino: String(info.ino) },
        target:
          info.type === "SymbolicLink" && followed !== undefined
            ? { dev: String(followed.dev), ino: String(followed.ino) }
            : null,
        linkTarget: info.type === "SymbolicLink" ? yield* fs.readLink(absolute) : null,
        facts: followed?.type === "Directory" ? yield* facts(absolute) : null,
      },
      evidence: yield* tree(absolute),
      ancestors,
    } satisfies Observed;
  });

  /** Rerun immediately before a commit: the destination is still exactly what was decided on. */
  const unchanged = (expected: Observed) =>
    Effect.gen(function* () {
      const current = yield* inspect(expected.path).pipe(Effect.provide(context));
      if (JSON.stringify(current) !== JSON.stringify(expected))
        return yield* new InstalledSkillFiles.InstalledSkillFailure({
          message: `Installed skill evidence changed before commit: ${expected.path}`,
        });
    });

  const commit = Effect.fn("InstalledSkills.commit")(function* (
    staged: Staged,
    options: {
      readonly mode: "manage" | "replace" | "install";
      readonly marker: OwnershipMarker;
      readonly recheck: Observed;
      readonly verification: string;
    },
  ) {
    const destination = options.recheck.path;
    let displaced: Option.Option<Backup> = Option.none();
    const committed = yield* InstalledSkillFiles.commitInstalledSkill(
      {
        root: staged.destination.root,
        staging: dirname(staged.path),
        path: staged.path,
        hash: staged.hash,
      },
      {
        mode: options.mode,
        destination,
        marker: options.marker,
        backUp: InstalledSkillBackups.backUpInstalledSkill(
          {
            root: staged.destination.root,
            path: destination,
            installed_skill_id: staged.copy.installedSkillId,
          },
          "replace",
        ).pipe(
          Effect.flatMap((path) =>
            Effect.map(InstalledSkillFiles.inspectOwnershipMarker(path), (marker) => {
              displaced = Option.some({ path, marker });
            }),
          ),
        ),
        check: unchanged(options.recheck),
        verification: options.verification,
      },
    ).pipe(
      Effect.provide(context),
      Effect.mapError((cause) => failed(destination, displaced)(cause)),
    );
    return { path: destination, hash: committed.hash, replaced: displaced };
  });

  return Service.of({
    active: routing === undefined ? unrouted() : routing.active,
    destinations: (scope) => (routing === undefined ? unrouted() : routing.destinations(scope)),
    identify: (path) =>
      installDestinationPathIdentity(path).pipe(
        Effect.map((identity) => ({
          key: identity.comparisonKey,
          canonicalPath: identity.canonicalPath ?? resolve(path),
        })),
        Effect.orElseSucceed(() => ({
          key: `path:${resolve(path)}`,
          canonicalPath: resolve(path),
        })),
        Effect.provide(context),
      ),
    inspect: (path) => inspect(path).pipe(Effect.provide(context), Effect.mapError(failed(path))),
    hash: (path) => hasher.hash(path).pipe(Effect.provide(context), Effect.mapError(failed(path))),
    check: Effect.fn("InstalledSkills.check")(function* (observed) {
      for (const expected of observed) {
        const current = yield* inspect(expected.path).pipe(
          Effect.provide(context),
          Effect.mapError(failed(expected.path)),
        );
        if (JSON.stringify(current) !== JSON.stringify(expected))
          return yield* new Changed({ path: expected.path });
      }
    }),
    prepare: Effect.fn("InstalledSkills.prepare")(function* (roots) {
      for (const root of new Set(roots))
        yield* ensureSkillsDirectoryWritable(root).pipe(
          Effect.provide(context),
          Effect.mapError(failed(root)),
        );
    }),
    build: Effect.fn("InstalledSkills.build")(function* (copy, destination) {
      const skill = copy.state.skills.find((item) => item.skill_id === copy.skillId);
      const version = skill?.versions.find((item) => item.skill_version_id === copy.skillVersionId);
      if (skill === undefined || version === undefined)
        return yield* failed(destination.root)(
          new InstalledSkillInvalid({
            detail: "An enabled Skill has no selected retained Version",
          }),
        );
      const source = yield* installedSkillSource(
        copy.state,
        copy.originalsPath,
        skill,
        version,
      ).pipe(Effect.provide(context), Effect.mapError(failed(destination.root)));
      if (source.kind === "invalid")
        return yield* failed(destination.root)(
          new InstalledSkillInvalid({ detail: source.detail }),
        );
      const staged = yield* InstalledSkillFiles.stageInstalledSkill({
        root: destination.root,
        libraryPath: source.libraryPath,
        sourcePath: source.sourcePath,
        target: destination.destination,
        invocationIntent: copy.invocationIntent,
        ...(source.shared === undefined ? {} : { shared: source.shared }),
        ...(source.declaredInvocation === undefined
          ? {}
          : { declaredInvocation: source.declaredInvocation }),
      }).pipe(Effect.provide(context), Effect.mapError(failed(destination.root)));
      return { copy, destination, path: staged.path, hash: staged.hash };
    }),
    install: (staged, marker, recheck) =>
      commit(staged, {
        mode: recheck.entry._tag === "Absent" ? "install" : "replace",
        marker,
        recheck,
        verification: "write",
      }),
    manage: (staged, marker, recheck, verification) =>
      commit(staged, { mode: "manage", marker, recheck, verification }),
    backUp: (path, into) =>
      InstalledSkillFiles.keepInstalledSkillVariant(path, into).pipe(
        Effect.provide(context),
        Effect.mapError(failed(path)),
      ),
    uninstall: Effect.fn("InstalledSkills.uninstall")(function* (root, path, installedSkillId) {
      const backup = yield* InstalledSkillBackups.backUpInstalledSkill(
        { root, path, installed_skill_id: installedSkillId },
        "retire",
      ).pipe(Effect.provide(context), Effect.mapError(failed(path)));
      return {
        path: backup,
        marker: yield* InstalledSkillFiles.inspectOwnershipMarker(backup).pipe(
          Effect.provide(context),
          Effect.mapError(failed(backup)),
        ),
      };
    }),
    duplicates: {
      scan: (scope, names) =>
        routing === undefined ? unrouted() : routing.duplicates.scan(scope, names),
    },
    backups: {
      scan: (root, installedSkillId) =>
        InstalledSkillBackups.pendingInstalledSkillBackups({
          root,
          installed_skill_id: installedSkillId,
        }).pipe(
          Effect.flatMap((paths) =>
            Effect.forEach(paths, (path) =>
              Effect.map(InstalledSkillFiles.inspectOwnershipMarker(path), (marker) => ({
                path,
                marker,
              })),
            ),
          ),
          Effect.provide(context),
          Effect.mapError(failed(root)),
        ),
      check: (backup, state, originalsPath, installedSkillId) =>
        InstalledSkillFiles.reproducible(backup.path, state, originalsPath, installedSkillId).pipe(
          Effect.provide(context),
          Effect.mapError(failed(backup.path)),
        ),
      keep: (backup) =>
        InstalledSkillBackups.keepInstalledSkillBackup(backup.path).pipe(
          Effect.provide(context),
          Effect.mapError(failed(backup.path)),
        ),
      discard: (backup) =>
        fs.remove(backup.path, { recursive: true }).pipe(Effect.mapError(failed(backup.path))),
    },
  });
});
export const layer = (routing?: Routing) => Layer.effect(Service, make(routing));
export * as InstalledSkills from "./installed-skills.js";
