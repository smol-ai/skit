import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { deterministicTreeHashEffect, LinkStat, writeJsonAtomicEffect } from "@smolai/skit-core";
import { PlanIsStale } from "../library/failures.js";
import { leavePnpmSkillEffect } from "../projection/pnpm-skills.js";

interface RecoveryEntry {
  name: string;
  path: string;
  recoveryPath: string;
  type: "Directory" | "SymbolicLink";
  dev: number;
  ino: number;
  linkTarget?: string;
  /** A moved directory's approved content hash; a moved link leaves its target in place. */
  observedHash?: string;
}

export interface RecoveryMoveRequest {
  readonly name: string;
  readonly path: string;
  /** Required for directories; links are moved without touching their target's bytes. */
  readonly observedHash?: string;
  /** Preserve an alias identity the caller already reviewed. */
  readonly approvedLink?: {
    readonly dev: number;
    readonly ino: number;
    readonly linkTarget: string;
  };
}

/** Capture approved files; only display facts and the operation escape this module. */
export const prepareRecoveryMoves = Effect.fn("RecoveryMoves.prepare")(function* (
  home: string,
  requests: readonly RecoveryMoveRequest[],
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const recoveryDirectory = join(home, "removed", randomUUID());
  const entries: RecoveryEntry[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.path)) continue;
    seen.add(request.path);
    const info = yield* links.identity.lstat(request.path);
    if (info.type !== "Directory" && info.type !== "SymbolicLink") return yield* new PlanIsStale();
    const linkTarget = info.type === "SymbolicLink" ? yield* fs.readLink(request.path) : undefined;
    if (
      request.approvedLink &&
      (info.type !== "SymbolicLink" ||
        info.dev !== request.approvedLink.dev ||
        info.ino !== request.approvedLink.ino ||
        linkTarget !== request.approvedLink.linkTarget)
    )
      return yield* new PlanIsStale();
    entries.push({
      name: request.name,
      path: request.path,
      recoveryPath: join(recoveryDirectory, `${entries.length + 1}-${basename(request.path)}`),
      type: info.type,
      dev: info.dev,
      ino: info.ino,
      ...(linkTarget === undefined ? {} : { linkTarget }),
      ...(info.type === "Directory" && request.observedHash !== undefined
        ? { observedHash: request.observedHash }
        : {}),
    });
  }
  return {
    recoveryDirectory,
    entries: entries.map(({ name, path, type }) => ({ name, path, type })),
    apply: () => applyRecoveryMoves({ recoveryDirectory, entries }),
  };
});

export type PreparedRecoveryMoves = Effect.Success<ReturnType<typeof prepareRecoveryMoves>>;

/**
 * Move each entry to recovery only while it is still the approved file: the same identity and link
 * target, and for a directory the same bytes and no new custody. Every entry is checked before any
 * moves, and each again immediately before its own move.
 */
const applyRecoveryMoves = Effect.fn("RecoveryMoves.apply")(function* (plan: {
  recoveryDirectory: string;
  entries: readonly RecoveryEntry[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const checkApproved = Effect.fn("RecoveryMoves.checkApproved")(function* (entry: RecoveryEntry) {
    yield* leavePnpmSkillEffect(entry.path);
    const current = yield* links.identity.lstat(entry.path);
    if (
      current.type !== entry.type ||
      current.dev !== entry.dev ||
      current.ino !== entry.ino ||
      (entry.linkTarget !== undefined && (yield* fs.readLink(entry.path)) !== entry.linkTarget)
    )
      return yield* new PlanIsStale();
    if (entry.type !== "Directory") return;
    const hash = yield* Effect.result(deterministicTreeHashEffect(entry.path));
    const marker = yield* fs
      .readFileString(join(entry.path, ".skit-ownership.json"))
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(undefined)
            : Effect.fail(new PlanIsStale()),
        ),
      );
    if (hash._tag === "Failure" || hash.success !== entry.observedHash || marker !== undefined)
      return yield* new PlanIsStale();
  });
  for (const entry of plan.entries) yield* checkApproved(entry);
  if (!plan.entries.length) return;
  yield* fs.makeDirectory(plan.recoveryDirectory, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  const receipt = () =>
    writeJsonAtomicEffect(join(plan.recoveryDirectory, "receipt.json"), {
      schemaVersion: 1,
      entries: plan.entries.map((entry) => ({ ...entry, moved: moved.includes(entry.path) })),
    });
  yield* receipt();
  for (const entry of plan.entries) {
    yield* checkApproved(entry);
    // rename moves the symlink itself. It neither dereferences nor rewrites the target.
    yield* fs.rename(entry.path, entry.recoveryPath);
    moved.push(entry.path);
    yield* receipt();
  }
});
