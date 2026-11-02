import type { PlatformError } from "effect/PlatformError";
import { dirname, join, resolve } from "node:path";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Digest } from "effect/crypto";
import { InstalledSkills } from "./installed-skills.js";
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
import type { LibraryState } from "./library-state.js";
import type { InstallScope } from "../vocabulary.js";

/** Where this machine installs: its active destinations, and copies Harnesses already read. */
export interface Routing {
  readonly active: InstalledSkills.Interface["active"];
  readonly destinations: InstalledSkills.Interface["destinations"];
  readonly duplicates: InstalledSkills.Interface["duplicates"];
}

/**
 * This device's skill folders. Without this machine's routing, its install destinations are
 * unknown rather than inactive: anything that needs them fails, and nothing is uninstalled for it.
 */
export const make = Effect.fn("InstalledSkills.make")(function* (routing?: Routing) {
  const unrouted = () =>
    Effect.fail(
      new InstalledSkills.Failed({
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
    (path: string, displaced: Option.Option<InstalledSkills.Backup> = Option.none()) =>
    (cause: InstalledSkills.Cause) =>
      new InstalledSkills.Failed({ path, cause, displaced });

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
        Effect.map((hash): InstalledSkills.Facts["hash"] => hash),
        Effect.catchTag("TreeError", (error) =>
          Effect.succeed({ _tag: "Unreadable" as const, reason: error.reason._tag }),
        ),
      ),
      realPath,
      insideRepository,
      holdsRepositoryFiles:
        (yield* fs.exists(join(path, ".git"))) ||
        (yield* fs.exists(join(path, "skit.remote.json"))),
    } satisfies InstalledSkills.Facts;
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
      } satisfies InstalledSkills.Observed;
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
    } satisfies InstalledSkills.Observed;
  });

  /** Rerun immediately before a commit: the destination is still exactly what was decided on. */
  const unchanged = (expected: InstalledSkills.Observed) =>
    Effect.gen(function* () {
      const current = yield* inspect(expected.path).pipe(Effect.provide(context));
      if (JSON.stringify(current) !== JSON.stringify(expected))
        return yield* new InstalledSkillFiles.InstalledSkillFailure({
          message: `Installed skill evidence changed before commit: ${expected.path}`,
        });
    });

  const commit = Effect.fn("InstalledSkills.commit")(function* (
    staged: InstalledSkills.Staged,
    options: {
      readonly mode: "manage" | "replace" | "install";
      readonly marker: OwnershipMarker;
      readonly recheck: InstalledSkills.Observed;
      readonly verification: string;
    },
  ) {
    const destination = options.recheck.path;
    let displaced: Option.Option<InstalledSkills.Backup> = Option.none();
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

  return InstalledSkills.Service.of({
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
          return yield* new InstalledSkills.Changed({ path: expected.path });
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
/**
 * Routes from where this device already has copies: each scope's recorded roots, each active. For
 * work that changes no routes, such as removing a Collection or updating copies in place.
 */
export const recordedRouting = Effect.fn("InstalledSkills.recordedRouting")(function* (
  state: LibraryState,
) {
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
  const recorded = state.installed_skills.flatMap((copy) =>
    copy.destination === "legacy" ? [] : [{ ...copy, destination: copy.destination }],
  );
  const active = [...new Set(recorded.map((copy) => copy.destination))];
  const destinations = (scope: InstallScope): readonly InstalledSkills.Destination[] =>
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

export const layer = (routing?: Routing) => Layer.effect(InstalledSkills.Service, make(routing));
export * as InstalledSkillsNode from "./installed-skills-node.js";
