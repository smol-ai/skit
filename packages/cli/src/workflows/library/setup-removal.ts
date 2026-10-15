import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { LinkStat, pathIsWithin } from "@smolai/skit-core";
import { collectHarnessRoots, type SetupOptions } from "./setup.js";
import type { SetupResult } from "./setup-contract.js";
import {
  prepareRecoveryMoves,
  type RecoveryMoveRequest,
} from "../../library-application/recovery-moves.js";

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
  const requests: RecoveryMoveRequest[] = [];
  for (const selection of selections) {
    for (const instance of observed.instances.filter((item) =>
      selection.paths.includes(item.path),
    )) {
      for (const path of removablePaths.get(instance.path) ?? [])
        requests.push({
          name: selection.name,
          path,
          observedHash: instance.contentIdentity.observedHash,
        });
    }
  }
  return yield* prepareRecoveryMoves(options.libraryHome, requests);
});
