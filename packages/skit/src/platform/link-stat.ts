// The platform seam for SKIT. Effect v4's FileSystem has no `lstat` — its `stat` is backed by
// NFS.stat and follows links — but rejecting symlinks is a security property of tree walking and
// path identity, so the service is extended with the one operation the platform omits.

import { Context, Effect, FileSystem, Layer, Option } from "effect";
import { PlatformError, systemError, type SystemErrorTag } from "effect/PlatformError";
import {
  accessSync,
  constants,
  lstat as nodeLstat,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";

export interface LinkStatShape {
  /** Metadata for `path` itself, never the target it points at. */
  readonly lstat: (path: string) => Effect.Effect<FileSystem.File.Info, PlatformError>;
  /**
   * The synchronous probes behind path identity.
   *
   * Path identity is observation, not IO orchestration: it runs inside map/filter callbacks and
   * was synchronous before the migration. Keeping these sync lets those effects run with
   * Effect.runSync and preserves the original event-loop behaviour exactly.
   */
  readonly identity: {
    readonly stat: (path: string) => Effect.Effect<PathStats, PlatformError>;
    readonly lstat: (path: string) => Effect.Effect<PathStats, PlatformError>;
    /**
     * Whether `path` is executable by this process.
     *
     * FileSystem.access tests ok, readable and writable only, so the executable bit — the whole
     * question when searching PATH — has no stock equivalent.
     */
    readonly executable: (path: string) => Effect.Effect<boolean, never>;
  };
  /**
   * libuv's realpath, not Node's JS implementation.
   *
   * FileSystem.realPath is backed by NFS.realpath. Path identity keys must be byte-faithful, so
   * the native resolver is exposed separately rather than silently substituted.
   */
  readonly realPathNative: (path: string) => Effect.Effect<string, PlatformError>;
}

/** Device and inode are always present from a Node stat, so identity keys need no Option. */
export interface PathStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly type: FileSystem.File.Info["type"];
}

export class LinkStat extends Context.Service<LinkStat, LinkStatShape>()("skit/LinkStat") {}

const errorTags: Record<string, SystemErrorTag> = {
  ENOENT: "NotFound",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  EEXIST: "AlreadyExists",
  EBUSY: "Busy",
  EAGAIN: "WouldBlock",
};

function pathStats(stats: Stats): PathStats {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, type: fileInfo(stats).type };
}

function fileInfo(stats: Stats): FileSystem.File.Info {
  return {
    type: stats.isFile()
      ? "File"
      : stats.isDirectory()
        ? "Directory"
        : stats.isSymbolicLink()
          ? "SymbolicLink"
          : stats.isBlockDevice()
            ? "BlockDevice"
            : stats.isCharacterDevice()
              ? "CharacterDevice"
              : stats.isFIFO()
                ? "FIFO"
                : stats.isSocket()
                  ? "Socket"
                  : "Unknown",
    mtime: Option.fromNullishOr(stats.mtime),
    atime: Option.fromNullishOr(stats.atime),
    birthtime: Option.fromNullishOr(stats.birthtime),
    dev: stats.dev,
    rdev: Option.fromNullishOr(stats.rdev),
    ino: Option.fromNullishOr(stats.ino),
    mode: stats.mode,
    nlink: Option.fromNullishOr(stats.nlink),
    uid: Option.fromNullishOr(stats.uid),
    gid: Option.fromNullishOr(stats.gid),
    size: FileSystem.Size(stats.size),
    blksize: Option.some(FileSystem.Size(stats.blksize)),
    blocks: Option.fromNullishOr(stats.blocks),
  };
}

/** The Node implementation. Tests provide their own layer instead. */
const platformFailure = (method: string, path: string) => (cause: unknown) =>
  systemError({
    _tag: errorTags[(cause as NodeJS.ErrnoException).code ?? ""] ?? "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause,
  });

export const linkStatLayer: Layer.Layer<LinkStat> = Layer.succeed(LinkStat)({
  identity: {
    stat: (path) =>
      Effect.try({
        try: () => pathStats(statSync(path)),
        catch: platformFailure("stat", path),
      }),
    lstat: (path) =>
      Effect.try({
        try: () => pathStats(lstatSync(path)),
        catch: platformFailure("lstat", path),
      }),
    executable: (path) =>
      Effect.sync(() => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
  },
  // node:fs/promises has no realpath.native, so the sync resolver is the faithful one.
  realPathNative: (path) =>
    Effect.try({
      try: () => realpathSync.native(path),
      catch: platformFailure("realPathNative", path),
    }),
  lstat: (path) =>
    Effect.callback<FileSystem.File.Info, PlatformError>((resume) => {
      nodeLstat(path, (cause, stats) =>
        resume(
          cause
            ? Effect.fail(platformFailure("lstat", path)(cause))
            : Effect.succeed(fileInfo(stats)),
        ),
      );
    }),
});
