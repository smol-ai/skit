// The audit's filesystem seam: every read and traversal the audit performs goes through it.
//
// These are Effects over the platform FileSystem and LinkStat services, so the audit's I/O belongs
// to the caller's fiber: an interrupted `skit audit` stops mid-walk instead of finishing it. The
// previous synchronous implementation reached node:fs directly and re-entered a runtime through
// runSkitSync for every path classification.
import { Effect, FileSystem } from "effect";
import {
  isJsonObject,
  LinkStat,
  observationPathIdentityEffect,
  type JsonObject,
} from "@smolai/skit-core";

const classify = Effect.fn("Audit.classify")(function* (path: string) {
  const linkStat = yield* LinkStat;
  return yield* Effect.all({
    link: Effect.option(linkStat.identity.lstat(path)),
    target: Effect.option(linkStat.identity.stat(path)),
  });
});

/** File contents, or null when the path cannot be read. Unreadable is evidence, not a failure. */
export const read = Effect.fn("Audit.read")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
});

export const readJson = Effect.fn("Audit.readJson")(function* (path: string) {
  const source = yield* read(path);
  if (!source) return null;
  try {
    const value: unknown = JSON.parse(source);
    return isJsonObject(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
});

export const walk = Effect.fn("Audit.walk")(function* (
  root: string,
  predicate: (path: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = Effect.fn("Audit.visit")(function* (
    directory: string,
  ): Effect.gen.Return<void, never, FileSystem.FileSystem | LinkStat> {
    if ((yield* classify(directory)).link._tag === "None") return;
    const canonicalKey = (yield* observationPathIdentityEffect(directory)).comparisonKey;
    if (visited.has(canonicalKey)) return;
    visited.add(canonicalKey);
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => null));
    if (names === null) return;
    for (const name of names) {
      if ([".git", "node_modules"].includes(name)) continue;
      const path = `${directory}/${name}`;
      // The audit follows a symlinked directory on purpose: it reports what a Harness would see.
      // Cycles are bounded by the visited set of canonical keys above.
      const { link, target } = yield* classify(path);
      if (link._tag === "None" || target._tag === "None") continue;
      const directoryEntry =
        link.value.type === "Directory" ||
        (link.value.type === "SymbolicLink" && target.value.type === "Directory");
      if (directoryEntry) yield* visit(path);
      else if (predicate(path)) result.push(path);
    }
  });
  yield* visit(root);
  return result.sort();
});

export const canonical = Effect.fn("Audit.canonical")(function* (path: string) {
  return (yield* observationPathIdentityEffect(path)).canonicalPath;
});

/** Whether the path itself exists. Broken symlinks count as existing audit evidence. */
export const pathExists = Effect.fn("Audit.exists")(function* (path: string) {
  const linkStat = yield* LinkStat;
  return (yield* Effect.option(linkStat.identity.lstat(path)))._tag === "Some";
});
