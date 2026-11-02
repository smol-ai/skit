import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema, Scope } from "effect";
import { dirname, join, resolve } from "node:path";
import { Digest } from "effect/crypto";
import * as InstalledSkillFiles from "../install/files.js";
import * as InstalledSkillBackups from "../install/backups.js";
import { LinkStat } from "../platform/link-stat.js";
import { SourceProcess } from "../platform/source-process.js";
import { TreeHasher } from "../artifact/tree-hasher.js";
import { deterministicTreeHash } from "../artifact/skit.js";
import { ensureSkillsDirectoryWritable } from "../install/writable.js";
import { installDestinationPathIdentity } from "../platform/path-identity.js";
import { sha256Hash } from "../shared/hash.js";
import { pnpmSkillOwner } from "../install/pnpm-skills.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
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
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { installedSkillSource } from "./installation/installed-skill-source.js";
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
export const make = Effect.fn("make")(function* (routing?: Routing) {
  const unrouted = () =>
    Effect.fail(
      new InstalledSkillInvalid({ detail: "This device's install destinations are unknown" }),
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

  /** The entry's own identity, and where a link points. Never follows a link to inspect it. */
  const identity = Effect.fn("identity")(function* (path: string) {
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
  const tree = Effect.fn("tree")(function* (path: string): Effect.fn.Return<string, PlatformError> {
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
  const facts = Effect.fn("facts")(function* (path: string) {
    const realPath = yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path)));
    let insideRepository = false;
    for (let directory = realPath; ; directory = dirname(directory)) {
      if (yield* fs.exists(join(directory, ".git"))) {
        insideRepository = true;
        break;
      }
      if (dirname(directory) === directory) break;
    }
    const holdsRepositoryFiles =
      (yield* fs.exists(join(path, ".git"))) || (yield* fs.exists(join(path, "skit.remote.json")));
    const protection: Protection | null = holdsRepositoryFiles
      ? "repository"
      : (yield* fs.exists(join(path, "skit.json"))) || (yield* fs.exists(join(path, ".skit")))
        ? "authored"
        : (yield* pnpmSkillOwner(path)) !== undefined
          ? "package-manager"
          : null;
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
      holdsRepositoryFiles,
      protection,
    } satisfies Facts;
  });

  const inspect = Effect.fn("inspect")(function* (path: string) {
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

  const commit = Effect.fn("commit")(function* (
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
    ).pipe(Effect.provide(context));
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
    inspect: (path) => inspect(path).pipe(Effect.provide(context)),
    hash: (path) => hasher.hash(path).pipe(Effect.provide(context)),
    check: Effect.fn("check")(function* (observed) {
      for (const expected of observed) {
        const current = yield* inspect(expected.path).pipe(Effect.provide(context));
        if (JSON.stringify(current) !== JSON.stringify(expected))
          return yield* new Changed({ path: expected.path });
      }
    }),
    prepare: Effect.fn("prepare")(function* (roots) {
      for (const root of new Set(roots))
        yield* ensureSkillsDirectoryWritable(root).pipe(Effect.provide(context));
    }),
    build: Effect.fn("build")(function* (copy, destination) {
      const skill = copy.state.skills.find((item) => item.skill_id === copy.skillId);
      const version = skill?.versions.find((item) => item.skill_version_id === copy.skillVersionId);
      if (skill === undefined || version === undefined)
        return yield* new InstalledSkillInvalid({
          detail: "An enabled Skill has no selected retained Version",
        });
      const source = yield* installedSkillSource(
        copy.state,
        copy.originalsPath,
        skill,
        version,
      ).pipe(Effect.provide(context));
      if (source.kind === "invalid")
        return yield* new InstalledSkillInvalid({ detail: source.detail });
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
      }).pipe(Effect.provide(context));
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
      InstalledSkillFiles.keepInstalledSkillVariant(path, into).pipe(Effect.provide(context)),
    uninstall: Effect.fn("uninstall")(function* (root, path, installedSkillId) {
      const backup = yield* InstalledSkillBackups.backUpInstalledSkill(
        { root, path, installed_skill_id: installedSkillId },
        "retire",
      ).pipe(Effect.provide(context));
      return {
        path: backup,
        marker: yield* InstalledSkillFiles.inspectOwnershipMarker(backup).pipe(
          Effect.provide(context),
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
        ),
      check: (backup, state, originalsPath, installedSkillId) =>
        InstalledSkillFiles.reproducible(backup.path, state, originalsPath, installedSkillId).pipe(
          Effect.provide(context),
        ),
      keep: (backup) =>
        InstalledSkillBackups.keepInstalledSkillBackup(backup.path).pipe(Effect.provide(context)),
      discard: (backup) => fs.remove(backup.path, { recursive: true }),
    },
  });
});
/**
 * Routes from where this device already has copies: each scope's recorded roots, each active. For
 * work that changes no routes, such as removing a Collection or updating copies in place.
 */
export const recordedRouting = Effect.fn("recordedRouting")(function* (state: LibraryState) {
  const fs = yield* FileSystem.FileSystem;
  const real = new Map<string, string>();
  for (const path of [
    ...state.repositories.map((repository) => repository.root),
    ...state.installed_skills.map((copy) => copy.root),
  ])
    real.set(path, yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => resolve(path))));
  const inside = (root: string, path: string) => {
    const [parent, child] = [real.get(root) ?? root, real.get(path) ?? path];
    return child === parent || child.startsWith(`${parent}/`);
  };
  const recorded = state.installed_skills;
  const active = [...new Set(recorded.map((copy) => copy.destination))];
  const destinations = (scope: InstallScope): readonly Destination[] =>
    recorded
      .filter((copy) =>
        scope.kind === "repository"
          ? inside(scope.root, copy.root)
          : !state.repositories.some((repository) => inside(repository.root, copy.root)),
      )
      .map((copy) => ({ destination: copy.destination, root: copy.root }))
      .filter(
        (target, index, all) =>
          all.findIndex(
            (other) => other.destination === target.destination && other.root === target.root,
          ) === index,
      );
  return {
    active: Effect.succeed(active),
    destinations: (scope) => Effect.succeed(destinations(scope)),
    duplicates: { scan: () => Effect.succeed({ copies: [], warnings: [], roots: [] }) },
  } satisfies Routing;
});

export const layer = (routing?: Routing) => Layer.effect(Service, make(routing));
export * as InstalledSkills from "./installed-skills.js";
