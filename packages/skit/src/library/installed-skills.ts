import { pathEntryIdentity, pathChain } from "../platform/path-evidence.js";
import {
  activeInstallDestinations,
  skillsDirectoryFor,
  type InventoryRootOptions,
} from "./routing/roots.js";
import { findDuplicates, readableSkillsDirectories } from "./routing/duplicates.js";
import {
  Changed,
  Destination,
  Duplicate,
  DuplicateScanIncomplete,
  Warning,
} from "./installed-skill-facts.js";
export { Changed, Destination, Duplicate } from "./installed-skill-facts.js";

import { Context, Effect, FileSystem, Option, Path, Schema, Scope } from "effect";
import { dirname, join, resolve } from "node:path";
import { Digest } from "effect/crypto";
import * as InstalledSkillFiles from "../installed-skills/files.js";
import * as InstalledSkillBackups from "../installed-skills/backups.js";
import { LinkStat } from "../platform/link-stat.js";
import { SourceProcess } from "../platform/source-process.js";
import { hashTree, deterministicTreeHash } from "../artifact/skit.js";

import { ensureSkillsDirectoryWritable } from "../installed-skills/writable.js";
import { installDestinationPathIdentity } from "../platform/path-identity.js";
import { sha256Hash, Hash } from "../shared/hash.js";
import { pnpmSkillOwner } from "../installed-skills/pnpm-skills.js";
import type { TreeRequirements } from "../platform/tree-requirements.js";
import type { PlatformError } from "effect/PlatformError";

import { InstallDestination } from "../installed-skills/destination.js";
import { type InstallScope } from "./scope.js";
import type { OwnershipMarker } from "../installed-skills/ownership-marker.js";
import type { LibraryState } from "./library-state.js";
import type { InstalledSkillId, SkillId, SkillVersionId } from "./entity-ids.js";
import {
  type InstalledSkillMutationError,
  type StagedInstalledSkill,
} from "../installed-skills/files.js";
import {
  inspectOwnershipMarker,
  OwnershipMarkerInspection,
} from "../installed-skills/marker-inspection.js";
import { InstalledSkillInvalid } from "./installation/install-enabled.js";
import { reproducible } from "./installation/retained-skill.js";
import { installedSkillSource } from "./installation/installed-skill-source.js";
import { declaredInvocationIntent, overrideInvocationIntent } from "../installed-skills/policy.js";
import type { Invocation } from "./enabled-plan.js";

import { TreeErrorReason, type TreeError } from "../shared/tree-error.js";

/**
 * Library's adapter from saved selections to installed-folder facts and operations.
 * Stored-version selection and recovery policy stay in Library; file construction is separate.
 */

/** Entries are compared by device identity, never by path alone. */
const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String });
export const Protection = Schema.Literals(["repository", "authored", "package-manager"]);
export type Protection = typeof Protection.Type;
/** What the installer reads at an existing folder, following a link as it always has. */
export const Facts = Schema.Struct({
  marker: OwnershipMarkerInspection,
  /** An empty or unhashable folder is a fact, never a planning failure. */
  hash: Schema.Union([Hash, Schema.TaggedStruct("Unreadable", { reason: TreeErrorReason })]),
  realPath: Schema.String,
  /** A `.git` at or above the folder: a checkout owns it. */
  insideRepository: Schema.Boolean,
  /** `.git` or `skit.remote.json` inside the folder. */
  holdsRepositoryFiles: Schema.Boolean,
  /**
   * Why the folder is someone else's in itself, so no Library plan touches it: a repository's
   * (`.git` or `skit.remote.json` inside it), an author's (`skit.json` or `.skit` inside it), or
   * pnpm's. A repository above the folder does not protect it. Null when it is not; plain data,
   * like the rest of a Folder, so it survives cloning into a plan.
   */
  protection: Schema.NullOr(Protection),
});
export type Facts = typeof Facts.Type;
const Entry = Schema.Union([
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Present", {
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
/** One path as it was when inspected. Plain data: it survives cloning into a plan. */
export const Folder = Schema.Struct({
  path: Schema.String,
  entry: Entry,
  /** Lossless evidence of everything in the entry, including what the hash leaves out. */
  evidence: Schema.String,
  ancestors: Schema.Array(Schema.Struct({ path: Schema.String, evidence: Schema.String })),
});
export type Folder = typeof Folder.Type;
/** A folder in recovery. */
export interface Backup {
  readonly path: string;
  readonly marker: OwnershipMarkerInspection;
}
interface Installed {
  readonly path: string;
  readonly hash: Hash;
  /** The predecessor this install moved to recovery, if there was one. */
  readonly replaced: Option.Option<Backup>;
}

export type Cause =
  | InstalledSkillMutationError
  | TreeError
  | PlatformError
  | DuplicateScanIncomplete
  | InstalledSkillInvalid
  | Effect.Error<ReturnType<typeof installedSkillSource>>
  | Effect.Error<ReturnType<typeof reproducible>>;
export interface Interface {
  /** Install destinations active on this device. Unknown routing counts every one as active. */
  readonly active: Effect.Effect<readonly InstallDestination[], Cause>;
  readonly destinations: (scope: InstallScope) => Effect.Effect<readonly Destination[], Cause>;
  /** A physical identity for a root, so a symlinked alias is the same root. Changes nothing. */
  readonly identify: (
    path: string,
  ) => Effect.Effect<{ readonly key: string; readonly canonicalPath: string }, Cause>;
  /** Changes nothing. */
  readonly inspect: (path: string) => Effect.Effect<Folder, Cause>;
  /** The hash an installed copy is decided and verified against. Changes nothing. */
  readonly hash: (path: string) => Effect.Effect<Hash, Cause>;
  /** Changes nothing: every folder is still exactly as it was inspected. */
  readonly check: (folders: readonly Folder[]) => Effect.Effect<void, Changed | Cause>;
  /** Create roots and prove them writable before saving enablement. */
  readonly prepare: (roots: readonly string[]) => Effect.Effect<void, Cause>;
  /**
   * Build one Installed Skill's bytes from `state`, the Library being planned or applied, so
   * Library can compare their hash with what is on disk. Staged beside `root`, they live as long as
   * the Scope.
   */
  readonly build: (
    installedSkill: {
      readonly skillId: SkillId;
      readonly skillVersionId: SkillVersionId;
      readonly destination: InstallDestination;
      readonly root: string;
      readonly invocation: Invocation;
    },
    state: LibraryState,
    originalsPath: string,
  ) => Effect.Effect<StagedInstalledSkill, Cause, Scope.Scope>;
  /**
   * Into an absent path, or over an owned copy, which goes to recovery as pending. `recheck` runs
   * immediately before the commit. Every operation below does only what Library decided.
   */
  readonly install: (
    staged: StagedInstalledSkill,
    marker: OwnershipMarker,
    recheck: Folder,
  ) => Effect.Effect<Installed, Cause>;
  /** Stamp SKIT's marker on a folder that already holds exactly the staged bytes. */
  readonly manage: (
    staged: StagedInstalledSkill,
    marker: OwnershipMarker,
    recheck: Folder,
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
export const make = Effect.fn("make")(function* (configuration?: Routing | InventoryRootOptions) {
  const unrouted = () =>
    Effect.fail(new InstalledSkillInvalid({ reason: { _tag: "DestinationsUnknown" } }));
  const context = (yield* Effect.context<TreeRequirements | Digest.Digest>()).pipe(
    Context.pick(FileSystem.FileSystem, Path.Path, LinkStat, SourceProcess, Digest.Digest),
  );
  let routing: Routing | undefined;
  if (configuration === undefined || !("home" in configuration)) routing = configuration;
  else {
    const roots = { ...configuration, overrides: structuredClone(configuration.overrides) };
    routing = {
      active: activeInstallDestinations(roots).pipe(Effect.provide(context)),
      destinations: Effect.fn("InstalledSkills.destinations")(function* (scope: InstallScope) {
        return (yield* activeInstallDestinations(roots).pipe(Effect.provide(context))).map(
          (destination) => ({
            destination,
            root: skillsDirectoryFor(destination, scope, roots),
          }),
        );
      }),
      duplicates: {
        scan: Effect.fn("InstalledSkills.duplicates")(function* (scope, names) {
          const warnings: Warning[] = [];
          const copies = names.length
            ? yield* findDuplicates(roots, scope, names, warnings).pipe(Effect.provide(context))
            : [];
          return {
            copies,
            warnings,
            roots: readableSkillsDirectories(roots, scope).map((root) => root.root),
          };
        }),
      },
    };
  }
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;

  const identity = (path: string) =>
    pathEntryIdentity(path).pipe(Effect.provideService(LinkStat, links));
  // Includes entries normalized hashes omit, and reads links without following them.
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
      marker: yield* inspectOwnershipMarker(path),
      hash: yield* deterministicTreeHash(path).pipe(
        Effect.map((hash): Facts["hash"] => hash),
        Effect.catchTag("TreeError", (error) =>
          Effect.succeed({ _tag: "Unreadable" as const, reason: error.reason }),
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
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
    const ancestors = yield* pathChain(dirname(absolute));
    if (info === undefined)
      return {
        path: absolute,
        entry: { _tag: "Absent" },
        evidence: "absent",
        ancestors,
      } satisfies Folder;
    const followed = yield* links.identity
      .stat(absolute)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
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
    } satisfies Folder;
  });

  /** Rerun immediately before a commit: the destination is still exactly what was decided on. */
  const unchanged = (expected: Folder) =>
    Effect.gen(function* () {
      const current = yield* inspect(expected.path).pipe(Effect.provide(context));
      if (JSON.stringify(current) !== JSON.stringify(expected))
        return yield* new InstalledSkillFiles.InstalledSkillFailure({
          reason: { _tag: "EvidenceChanged", path: expected.path },
        });
    });

  const commit = Effect.fn("commit")(function* (
    staged: StagedInstalledSkill,
    options: {
      readonly mode: "manage" | "replace" | "install";
      readonly marker: OwnershipMarker;
      readonly recheck: Folder;
      readonly verification: string;
    },
  ) {
    const destination = options.recheck.path;
    let displaced: Option.Option<Backup> = Option.none();
    const committed = yield* InstalledSkillFiles.commitInstalledSkill(staged, {
      mode: options.mode,
      destination,
      marker: options.marker,
      backUp: InstalledSkillBackups.backUpInstalledSkill(
        {
          root: staged.root,
          path: destination,
          installed_skill_id: options.marker.installed_skill_id,
        },
        "replace",
      ).pipe(
        Effect.flatMap((path) =>
          Effect.map(inspectOwnershipMarker(path), (marker) => {
            displaced = Option.some({ path, marker });
          }),
        ),
      ),
      check: unchanged(options.recheck),
      verification: options.verification,
    }).pipe(Effect.provide(context));
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
    hash: (path) => hashTree(path).pipe(Effect.provide(context)),
    check: Effect.fn("check")(function* (folders) {
      for (const expected of folders) {
        const current = yield* inspect(expected.path).pipe(Effect.provide(context));
        if (JSON.stringify(current) !== JSON.stringify(expected))
          return yield* new Changed({ path: expected.path });
      }
    }),
    prepare: Effect.fn("prepare")(function* (roots) {
      for (const root of new Set(roots))
        yield* ensureSkillsDirectoryWritable(root).pipe(Effect.provide(context));
    }),
    build: Effect.fn("build")(function* (installedSkill, state, originalsPath) {
      const skill = state.skills.find((item) => item.skill_id === installedSkill.skillId);
      const version = skill?.versions.find(
        (item) => item.skill_version_id === installedSkill.skillVersionId,
      );
      if (skill === undefined || version === undefined)
        return yield* new InstalledSkillInvalid({
          reason: { _tag: "VersionMissing", kind: "enabled" },
        });
      const source = yield* installedSkillSource(state, originalsPath, skill, version).pipe(
        Effect.provide(context),
      );
      if (source.kind === "invalid")
        return yield* new InstalledSkillInvalid({ reason: source.reason });
      return yield* InstalledSkillFiles.stageInstalledSkill({
        root: installedSkill.root,
        libraryPath: source.libraryPath,
        sourcePath: source.sourcePath,
        target: installedSkill.destination,
        invocationIntent:
          installedSkill.invocation === "declared"
            ? declaredInvocationIntent
            : overrideInvocationIntent(installedSkill.invocation),
        ...(source.shared === undefined ? {} : { shared: source.shared }),
        ...(source.declaredInvocation === undefined
          ? {}
          : { declaredInvocation: source.declaredInvocation }),
      }).pipe(Effect.provide(context));
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
        "uninstall",
      ).pipe(Effect.provide(context));
      return {
        path: backup,
        marker: yield* inspectOwnershipMarker(backup).pipe(Effect.provide(context)),
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
              Effect.map(inspectOwnershipMarker(path), (marker) => ({
                path,
                marker,
              })),
            ),
          ),
          Effect.provide(context),
        ),
      check: (backup, state, originalsPath, installedSkillId) =>
        reproducible(backup.path, state, originalsPath, installedSkillId).pipe(
          Effect.provide(context),
        ),
      keep: (backup) =>
        InstalledSkillBackups.keepInstalledSkillBackup(backup.path).pipe(Effect.provide(context)),
      discard: (backup) => fs.remove(backup.path, { recursive: true }),
    },
  });
});
