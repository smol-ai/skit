import { dirname, resolve } from "node:path";
import { Effect, Option } from "effect";
import { LinkStat } from "../../platform/link-stat.js";
import { readPathEvidence } from "../folder-evidence.js";
import { pathIsWithin } from "../../platform/path-identity.js";
import type * as Library from "../library.js";
import { StalePlan } from "../library-plan.js";
import type { SetupOptions } from "./scan.js";
import { collectSkillsDirectories } from "./discovery.js";
import type { SetupResult } from "./contract.js";

/** The copies setup removes, as reviewed: what to show, and the evidence its Remove step records. */
export interface SetupRemovals {
  readonly entries: {
    readonly name: string;
    readonly path: string;
    readonly type: "Directory" | "SymbolicLink";
  }[];
  readonly folders: readonly (Library.FolderEvidence | Library.LinkEvidence)[];
}

/** Only observed, unmanaged agent locations are removable. Canonical source trees stay put. */
export const setupRemovablePaths = Effect.fn("Setup.removablePaths")(function* (
  options: SetupOptions,
  scan: SetupResult,
) {
  const links = yield* LinkStat;
  const roots: string[] = [];
  for (const { root } of collectSkillsDirectories(
    options.inventory,
    scan.repositories.map((item) => item.path),
  )) {
    const info = yield* Effect.result(links.lstat(root));
    // A whole skills-root symlink is shared source storage, not a disposable installed copy.
    if (info._tag === "Success" && info.success.type === "Directory")
      roots.push(yield* links.realPathNative(root));
  }
  const paths = new Map<string, string[]>();
  for (const instance of scan.instances) {
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

/**
 * Record each selected removable copy as it is now. A folder must still hold the bytes the scan
 * saw; setup's Remove step moves only what matches this evidence.
 */
export const planSetupRemovals = Effect.fn("Setup.planRemovals")(function* (
  scan: SetupResult,
  selections: readonly { readonly name: string; readonly paths: readonly string[] }[],
  removablePaths: ReadonlyMap<string, readonly string[]>,
) {
  const entries: SetupRemovals["entries"][number][] = [];
  const folders: SetupRemovals["folders"][number][] = [];
  for (const selection of selections)
    for (const instance of scan.instances.filter((item) => selection.paths.includes(item.path)))
      for (const path of removablePaths.get(instance.path) ?? []) {
        if (folders.some((folder) => folder.path === path)) continue;
        const observed = yield* readPathEvidence(path);
        if (Option.isNone(observed))
          return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
        const evidence = observed.value;
        if (
          evidence._tag === "Directory" &&
          (instance.contentIdentity.status !== "hashed" ||
            evidence.treeHash !== instance.contentIdentity.currentHash)
        )
          return yield* new StalePlan({ reason: { _tag: "ReviewedStateChanged" } });
        entries.push({ name: selection.name, path, type: evidence._tag });
        folders.push(evidence);
      }
  return { entries, folders } satisfies SetupRemovals;
});
