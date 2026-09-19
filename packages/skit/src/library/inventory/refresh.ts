import { Clock, Effect, FileSystem, Result } from "effect";
import { dirname, join, resolve } from "node:path";
import type { HarnessName } from "../../contracts.js";
import type { LibraryState } from "../portable-local-state.js";
import { LinkStat } from "../../platform/link-stat.js";
import { deterministicTreeHashEffect } from "../../artifact/skit.js";
import { observationPathIdentityEffect, pathIsWithin } from "../../platform/path-identity.js";
import {
  expectedProjectionHashResult,
  readOwnershipMarkerEffect,
  inspectOwnershipMarkerEffect,
} from "../../projection/mutation.js";
import { LibraryStore } from "../store/library-store.js";
export interface InventoryScanRoot {
  readonly harness: HarnessName;
  readonly root: string;
}
export function deduplicateInventoryRoots(
  roots: readonly InventoryScanRoot[],
): InventoryScanRoot[] {
  return [
    ...new Map(
      roots.map(({ harness, root }) => [
        JSON.stringify([harness, resolve(root)]),
        { harness, root: resolve(root) },
      ]),
    ).values(),
  ];
}
/** Observe a private snapshot without persistence or recovery capabilities. */
export const observeInventory = Effect.fn("Library.observeInventory")(function* (
  loaded: LibraryState,
  scanRoots: readonly InventoryScanRoot[],
) {
  const state = structuredClone(loaded);
  const scanIssues = (state.scanIssues ?? []).filter(
    (item) => !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  const fs = yield* FileSystem.FileSystem;
  for (const projection of state.projections) {
    const skill = state.skills.find((item) => item.skill_id === projection.skill_id);
    const version = skill?.versions.find(
      (item) => item.skill_version_id === projection.skill_version_id,
    );
    if (skill === undefined || version === undefined) continue;
    if (!(yield* fs.exists(projection.path))) {
      if (projection.status !== "suppressed") {
        projection.status = "suppressed";
        projection.suppression_reason = "native_delete";
        projection.suppressed_at = new Date(yield* Clock.currentTimeMillis).toISOString();
      }
      continue;
    }
    const observed = yield* deterministicTreeHashEffect(projection.path);
    const marker = yield* readOwnershipMarkerEffect(projection.path);
    projection.observed_digest = observed;
    const expected = expectedProjectionHashResult(projection, marker);
    projection.status =
      marker && Result.isSuccess(expected) && observed === expected.success
        ? "installed"
        : "conflicted";
  }
  const managed = new Set<string>();
  for (const projection of state.projections)
    managed.add((yield* observationPathIdentityEffect(projection.path)).comparisonKey);
  const priorUnmanaged = new Map<string, LibraryState["unmanaged"][number]>();
  for (const item of state.unmanaged)
    priorUnmanaged.set((yield* observationPathIdentityEffect(item.path)).comparisonKey, item);
  state.unmanaged = state.unmanaged.filter(
    (item) =>
      typeof item.path !== "string" || !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  state.custodyIssues = (state.custodyIssues ?? []).filter(
    (item) => !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  const observedPaths = new Map<
    string,
    {
      path: string;
      harness: HarnessName;
      paths: Set<string>;
      canonicalPath: string;
      harnesses: Set<HarnessName>;
    }
  >();
  for (const { harness, root } of scanRoots)
    if (root) {
      // Missing and unreadable roots are evidence gaps, not successful empty scans.
      const entries = yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const probe = yield* LinkStat;
        const names = yield* fs.readDirectory(root);
        return yield* Effect.forEach(names.sort(), (name) =>
          probe.identity.lstat(join(root, name)).pipe(
            Effect.map((info) => ({ name, info })),
            Effect.catchTag("PlatformError", (error) => {
              if (error.reason._tag === "NotFound") return Effect.succeed(undefined);
              if (error.reason._tag !== "PermissionDenied") return Effect.fail(error);
              scanIssues.push({ path: join(root, name), harness, code: "UNREADABLE_PATH" });
              return Effect.succeed(undefined);
            }),
          ),
        );
      }).pipe(
        Effect.catchTag("PlatformError", (error) => {
          if (error.reason._tag !== "NotFound" && error.reason._tag !== "PermissionDenied")
            return Effect.fail(error);
          scanIssues.push({
            path: root,
            harness,
            code: error.reason._tag === "NotFound" ? "MISSING_ROOT" : "UNREADABLE_PATH",
          });
          return Effect.succeed(undefined);
        }),
      );
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry) continue;
        if (entry.info.type !== "Directory" && entry.info.type !== "SymbolicLink") continue;
        const path = join(root, entry.name);
        let directory = entry.info.type === "Directory";
        const skill = yield* Effect.gen(function* () {
          if (entry.info.type === "SymbolicLink") {
            const target = yield* fs.stat(path).pipe(
              Effect.catchTag("PlatformError", (error) => {
                if (error.reason._tag !== "NotFound") return Effect.fail(error);
                return fs.readLink(path).pipe(
                  Effect.map((target) => {
                    scanIssues.push({
                      path,
                      target: resolve(dirname(path), target),
                      harness,
                      code: "DANGLING_SYMLINK",
                    });
                    return undefined;
                  }),
                );
              }),
            );
            if (!target || target.type !== "Directory") return false;
            directory = true;
          }
          const document = yield* fs.stat(join(path, "SKILL.md"));
          return document.type === "File";
        }).pipe(
          Effect.catchTag("PlatformError", (error) => {
            if (error.reason._tag === "NotFound") {
              return Effect.succeed(false);
            }
            if (error.reason._tag !== "PermissionDenied") return Effect.fail(error);
            scanIssues.push({ path, harness, code: "UNREADABLE_PATH" });
            return Effect.succeed(false);
          }),
        );
        if (!skill && (!directory || (yield* inspectOwnershipMarkerEffect(path)).kind === "absent"))
          continue;
        const identity = yield* observationPathIdentityEffect(path);
        if (managed.has(identity.comparisonKey)) continue;
        const observed = observedPaths.get(identity.comparisonKey) ?? {
          path,
          harness,
          paths: new Set<string>(),
          canonicalPath: identity.canonicalPath,
          harnesses: new Set<HarnessName>(),
        };
        observed.harnesses.add(harness);
        observed.paths.add(path);
        observedPaths.set(identity.comparisonKey, observed);
      }
    }
  for (const observed of observedPaths.values()) {
    const harnesses = [...observed.harnesses].sort();
    const observedHash = yield* deterministicTreeHashEffect(observed.canonicalPath);
    const marker = yield* inspectOwnershipMarkerEffect(observed.path);
    if (marker.kind === "invalid") {
      state.custodyIssues.push({
        code: "INVALID_OWNERSHIP_MARKER",
        path: observed.path,
        canonicalPath: observed.canonicalPath,
        harnesses,
        observedHash,
        detail: marker.detail,
      });
    } else if (marker.kind === "valid") {
      const claim = {
        skillId: marker.marker.skill_id,
        projectionId: marker.marker.projection_id,
        expectedHash: marker.marker.expected_digest,
      };
      state.custodyIssues.push({
        code: "ORPHANED_PROJECTION_CLAIM",
        path: observed.path,
        canonicalPath: observed.canonicalPath,
        harnesses,
        observedHash,
        ...claim,
        matchesExpectedHash: observedHash === claim.expectedHash,
        detail: "Ownership marker is not independently authenticated and cannot authorize removal",
      });
    } else {
      const prior = priorUnmanaged.get(
        (yield* observationPathIdentityEffect(observed.path)).comparisonKey,
      );
      state.unmanaged.push({
        harness: observed.harness,
        harnesses,
        path: observed.path,
        paths: [...observed.paths],
        observedHash,
        ...(prior ? { lastObservedHash: prior.observedHash } : {}),
      });
    }
  }
  if (scanIssues.length) state.scanIssues = scanIssues;
  else delete state.scanIssues;
  return state;
});
/** Refresh device observations on authoritative Collections without a legacy Entry view. */
export const refreshPortableInventory = Effect.fn("Library.refreshPortableInventory")(function* (
  loaded: LibraryState,
  selectRoots: (state: LibraryState) => readonly InventoryScanRoot[],
) {
  const store = yield* LibraryStore;
  const roots = deduplicateInventoryRoots(selectRoots(loaded));
  const state = yield* observeInventory(loaded, roots);
  yield* store.publish(state);
  return { state, roots };
});
