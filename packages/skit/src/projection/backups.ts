import { Clock, Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { UnsafeInstalledSkillBackups } from "../failures.js";
import { makeOperationId } from "../library/entity-ids.js";
import type { InstalledSkill } from "../library/library-state.js";
import { LinkStat } from "../platform/link-stat.js";

const BACKUPS_DIRECTORY = ".skit-backups";
const IGNORE_EVERYTHING = "*\n";

/**
 * Where SKIT stages and backs up copies for a root. Beside the real root, a scan of the root never
 * sees them; but a root mounted from another device shares that device only with its own entries,
 * and a rename is the only lossless move, so there they live hidden inside the root instead.
 */
export const installedSkillWorkDirectory = (
  realRoot: string,
  rootDevice: number,
  parentDevice: number,
) => (rootDevice === parentDevice ? dirname(realRoot) : realRoot);

export const installedSkillWorkDirectoryEffect = Effect.fn("Projection.workDirectory")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const realRoot = yield* fs.realPath(root);
  return installedSkillWorkDirectory(
    realRoot,
    (yield* fs.stat(realRoot)).dev,
    (yield* fs.stat(dirname(realRoot))).dev,
  );
});

/**
 * Move an owned copy aside instead of deleting it. It stays `pending` until the Library state that
 * no longer records it is saved, so its absence is never read as the user's deletion.
 */
export const backUpInstalledSkill = Effect.fn("Projection.backUp")(function* (
  projection: Pick<InstalledSkill, "root" | "path" | "projection_id">,
  action: "replace" | "retire",
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const backups = join(
    yield* installedSkillWorkDirectoryEffect(projection.root),
    BACKUPS_DIRECTORY,
  );
  yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
  // A repository can commit its own `.skit-backups`, so never follow a link planted there.
  if ((yield* links.lstat(backups)).type !== "Directory")
    return yield* new UnsafeInstalledSkillBackups({ path: backups });
  // Backups beside a repository's skills directory must never be committed with it. An existing ignore
  // file is only read, never rewritten, and must still ignore everything.
  const ignore = join(backups, ".gitignore");
  const created = yield* fs
    .writeFileString(ignore, IGNORE_EVERYTHING, { mode: 0o600, flag: "wx" })
    .pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  if (
    !created &&
    ((yield* links.lstat(ignore)).type !== "File" ||
      (yield* fs.readFileString(ignore)) !== IGNORE_EVERYTHING)
  )
    return yield* new UnsafeInstalledSkillBackups({ path: ignore });
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(":", "-");
  const backup = join(
    backups,
    `pending-${projection.projection_id}-${stamp}-${action}-${makeOperationId()}`,
  );
  yield* fs.rename(projection.path, backup).pipe(Effect.uninterruptible);
  return backup;
});

/** Pending backups of one installed skill, wherever its root's device placed them. */
const installedSkillBackups = Effect.fn("Projection.backups")(function* (
  projection: Pick<InstalledSkill, "root" | "projection_id">,
  includeKept: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const realRoot = yield* fs
    .realPath(projection.root)
    .pipe(Effect.orElseSucceed(() => resolve(projection.root)));
  const pending: string[] = [];
  for (const workDirectory of [dirname(realRoot), realRoot]) {
    const backups = join(workDirectory, BACKUPS_DIRECTORY);
    // SKIT never backs up through a link, so a planted one holds none of its backups; keeping or
    // discarding what it points at would rename or delete files outside the backups.
    const type = yield* links.lstat(backups).pipe(
      Effect.map((info) => info.type),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    if (type !== "Directory") continue;
    const names = yield* fs.readDirectory(backups);
    pending.push(
      ...names
        .filter(
          (name) =>
            name.startsWith(`pending-${projection.projection_id}-`) ||
            (includeKept && name.startsWith(`kept-${projection.projection_id}-`)),
        )
        .map((name) => join(backups, name)),
    );
  }
  return pending;
});

/** Unsettled backups retain their existing narrow protocol. */
export const pendingInstalledSkillBackups = (
  projection: Pick<InstalledSkill, "root" | "projection_id">,
) => installedSkillBackups(projection, false);

/** Inspect both kept and pending predecessors without following a redirected backup directory. */
export const inspectInstalledSkillBackups = (
  projection: Pick<InstalledSkill, "root" | "projection_id">,
) => installedSkillBackups(projection, true);

/** A kept backup may hold bytes nothing else does. It stays until an operator removes it. */
export const keepInstalledSkillBackup = Effect.fn("Projection.keepBackup")(function* (
  backup: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.rename(
    backup,
    join(dirname(backup), `kept-${basename(backup).slice("pending-".length)}`),
  );
});

/**
 * Every name, type, mode and byte of a copy, its root included, except its ownership marker: what
 * a backup must equal before it can be discarded. Entries are structured and serialized with JSON
 * escaping, so no name can impersonate another entry. Undefined for anything else, such as a link,
 * which SKIT never writes and this comparison does not cover.
 */
export const losslessTree = Effect.fn("Projection.losslessTree")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const entries: Array<{ path: string[]; type: string; mode: number; sha256?: string }> = [];
  let covered = true;
  const visit = (path: string, names: string[]): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const info = yield* links.lstat(path);
      const mode = info.mode & 0o7777;
      if (info.type === "Directory") {
        entries.push({ path: names, type: "directory", mode });
        for (const name of (yield* fs.readDirectory(path)).sort())
          if (names.length > 0 || name !== ".skit-ownership.json")
            yield* visit(join(path, name), [...names, name]);
      } else if (info.type === "File")
        entries.push({
          path: names,
          type: "file",
          mode,
          sha256: createHash("sha256")
            .update(yield* fs.readFile(path))
            .digest("hex"),
        });
      else covered = false;
    });
  yield* visit(root, []);
  return covered ? JSON.stringify(entries) : undefined;
});
