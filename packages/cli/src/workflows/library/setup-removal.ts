import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { Effect, FileSystem } from "effect";
import { LinkStat, pathIsWithin, writeJsonAtomicEffect } from "@smolai/skit-core";
import { PlanIsStale } from "../../library/failures.js";
import { collectHarnessRoots, type SetupOptions } from "./setup.js";
import type { SetupResult } from "./setup-contract.js";
import { leavePnpmSkillEffect } from "../../projection/pnpm-skills.js";

export interface SetupRemoval {
  name: string;
  path: string;
  recoveryPath: string;
  type: "Directory" | "SymbolicLink";
  dev: number;
  ino: number;
  linkTarget?: string;
}

/** Only observed, unmanaged agent locations are removable. Canonical source trees stay put. */
export const setupRemovablePaths = Effect.fn("Setup.removablePaths")(function* (
  options: SetupOptions,
  observed: SetupResult,
) {
  const links = yield* LinkStat;
  const roots: string[] = [];
  for (const { root } of collectHarnessRoots(
    options.inventory,
    observed.repositories.map((item) => item.path),
  )) {
    const info = yield* Effect.result(links.lstat(root));
    // A whole skills-root symlink is shared source storage, not a disposable installed copy.
    if (info._tag === "Success" && info.success.type === "Directory")
      roots.push(yield* links.realPathNative(root));
  }
  const paths = new Map<string, string[]>();
  for (const instance of observed.instances) {
    if (
      instance.owner.kind === "skit" ||
      instance.owner.kind === "authored" ||
      instance.owner.kind === "pnpm" ||
      instance.owner.kind === "invalid-marker"
    )
      continue;
    const eligible: string[] = [];
    const symlinks: string[] = [];
    const identities = new Set<string>();
    for (const path of new Set([...instance.aliases, instance.path])) {
      const parent = yield* links.realPathNative(dirname(path));
      if (!roots.some((root) => parent === root || pathIsWithin(root, parent))) continue;
      const info = yield* links.identity.lstat(path);
      if (info.type !== "Directory" && info.type !== "SymbolicLink") continue;
      const identity = `${info.dev}:${info.ino}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      eligible.push(resolve(path));
      if (info.type === "SymbolicLink") symlinks.push(resolve(path));
    }
    // For linked installations, remove the links and preserve their shared source directory.
    paths.set(instance.path, (symlinks.length ? symlinks : eligible).sort());
  }
  return paths;
});

export const planSetupRemovals = Effect.fn("Setup.planRemovals")(function* (
  options: SetupOptions,
  observed: SetupResult,
  selections: readonly { readonly name: string; readonly paths: readonly string[] }[],
  removablePaths: ReadonlyMap<string, readonly string[]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  const recoveryDirectory = join(options.libraryHome, "removed", randomUUID());
  const entries: SetupRemoval[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const instancePaths = observed.instances
      .filter((instance) => selection.paths.includes(instance.path))
      .flatMap((instance) => removablePaths.get(instance.path) ?? []);
    for (const path of instancePaths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const info = yield* links.identity.lstat(path);
      if (info.type !== "Directory" && info.type !== "SymbolicLink")
        return yield* new PlanIsStale();
      entries.push({
        name: selection.name,
        path,
        recoveryPath: join(recoveryDirectory, `${entries.length + 1}-${basename(path)}`),
        type: info.type,
        dev: info.dev,
        ino: info.ino,
        ...(info.type === "SymbolicLink" ? { linkTarget: yield* fs.readLink(path) } : {}),
      });
    }
  }
  return { recoveryDirectory, entries };
});

/** The caller revalidates the entire setup observation immediately before applying this plan. */
export const applySetupRemovals = Effect.fn("Setup.applyRemovals")(function* (
  plan: Effect.Success<ReturnType<typeof planSetupRemovals>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const links = yield* LinkStat;
  for (const entry of plan.entries) {
    yield* leavePnpmSkillEffect(entry.path);
    const current = yield* links.identity.lstat(entry.path);
    if (
      current.type !== entry.type ||
      current.dev !== entry.dev ||
      current.ino !== entry.ino ||
      (entry.linkTarget !== undefined && (yield* fs.readLink(entry.path)) !== entry.linkTarget)
    )
      return yield* new PlanIsStale();
  }
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
    // rename moves the symlink itself. It neither dereferences nor rewrites the target.
    yield* fs.rename(entry.path, entry.recoveryPath);
    moved.push(entry.path);
    yield* receipt();
  }
});
