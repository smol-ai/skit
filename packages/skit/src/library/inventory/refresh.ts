import { Clock, Effect, FileSystem, Result } from "effect";
import { dirname, join, resolve } from "node:path";
import type { HarnessName } from "../../contracts.js";
import type { InstalledSkill, LibraryState } from "../library-state.js";
import * as InstalledSkillStatus from "../installed-skill-status.js";
import { LinkStat } from "../../platform/link-stat.js";
import { deterministicTreeHash } from "../../artifact/skit.js";
import { physicalPath, pathIsWithin } from "../../platform/path-identity.js";
import {
  expectedInstalledSkillHashResult,
  installedSkillDisplaced,
  readOwnershipMarker,
  inspectOwnershipMarker,
} from "../../install/files.js";
import { type InventoryScanRoot } from "./roots.js";
export { deduplicateInventoryRoots, type InventoryScanRoot } from "./roots.js";

/** Scan into a copy of `loaded`. Saves nothing and backs nothing up. */
export const scanInventory = Effect.fn("Library.scanInventory")(function* (
  loaded: LibraryState,
  scanRoots: readonly InventoryScanRoot[],
  observedAt?: string,
) {
  const scannedAt = observedAt ?? new Date(yield* Clock.currentTimeMillis).toISOString();
  const fs = yield* FileSystem.FileSystem;
  const installedSkills = yield* Effect.forEach(
    loaded.installed_skills,
    Effect.fnUntraced(function* (installedSkill: InstalledSkill) {
      const skill = loaded.skills.find((item) => item.skill_id === installedSkill.skill_id);
      const version = skill?.versions.find(
        (item) => item.skill_version_id === installedSkill.skill_version_id,
      );
      if (skill === undefined || version === undefined) return installedSkill;
      if (!(yield* fs.exists(installedSkill.path))) {
        // Pending copies may be between managed retirement and sync rematerialization. Their
        // absence is not evidence that the user deleted an installed copy.
        if (installedSkill.status === "pending" || installedSkill.status === "suppressed")
          return installedSkill;
        // Nor is the absence of the very copy SKIT moved aside before it could save why.
        return (yield* installedSkillDisplaced(installedSkill))
          ? InstalledSkillStatus.pending(installedSkill)
          : InstalledSkillStatus.suppressed(installedSkill, scannedAt);
      }
      const currentHash = yield* deterministicTreeHash(installedSkill.path);
      const marker = yield* readOwnershipMarker(installedSkill.path);
      // Recorded before its marker was written, and the folder is still exactly SKIT's bytes:
      // the marker is pending, and the next change that plans this copy writes it.
      if (
        installedSkill.status === "pending" &&
        marker === null &&
        currentHash === installedSkill.expected_hash
      )
        return installedSkill;
      const expected = expectedInstalledSkillHashResult(installedSkill, marker);
      return marker && Result.isSuccess(expected) && currentHash === expected.success
        ? InstalledSkillStatus.installed(installedSkill)
        : InstalledSkillStatus.conflicted(installedSkill, currentHash);
    }),
  );
  const state = { ...structuredClone(loaded), installed_skills: installedSkills };
  const scanIssues = (state.scanIssues ?? []).filter(
    (item) => !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  const managed = new Set<string>();
  for (const installedSkill of state.installed_skills)
    managed.add((yield* physicalPath(installedSkill.path)).key);
  const priorUnmanaged = new Map<string, LibraryState["unmanaged"][number]>();
  for (const item of state.unmanaged)
    priorUnmanaged.set((yield* physicalPath(item.path)).key, item);
  state.unmanaged = state.unmanaged.filter(
    (item) =>
      typeof item.path !== "string" || !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  state.ownershipIssues = (state.ownershipIssues ?? []).filter(
    (item) => !scanRoots.some(({ root }) => pathIsWithin(root, item.path)),
  );
  const foundPaths = new Map<
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
        if (!skill && (!directory || (yield* inspectOwnershipMarker(path)).kind === "absent"))
          continue;
        const identity = yield* physicalPath(path);
        if (managed.has(identity.key)) continue;
        const observed = foundPaths.get(identity.key) ?? {
          path,
          harness,
          paths: new Set<string>(),
          canonicalPath: identity.realPath,
          harnesses: new Set<HarnessName>(),
        };
        observed.harnesses.add(harness);
        observed.paths.add(path);
        foundPaths.set(identity.key, observed);
      }
    }
  for (const observed of foundPaths.values()) {
    const harnesses = [...observed.harnesses].sort();
    const currentHash = yield* deterministicTreeHash(observed.canonicalPath);
    const marker = yield* inspectOwnershipMarker(observed.path);
    if (marker.kind === "invalid") {
      state.ownershipIssues.push({
        code: "INVALID_OWNERSHIP_MARKER",
        path: observed.path,
        canonicalPath: observed.canonicalPath,
        harnesses,
        currentHash,
        detail: marker.detail,
      });
    } else if (marker.kind === "valid") {
      const claim = {
        skillId: marker.marker.skill_id,
        installedSkillId: marker.marker.installed_skill_id,
        expectedHash: marker.marker.expected_hash,
      };
      state.ownershipIssues.push({
        code: "ORPHANED_OWNERSHIP_MARKER",
        path: observed.path,
        canonicalPath: observed.canonicalPath,
        harnesses,
        currentHash,
        ...claim,
        matchesExpectedHash: currentHash === claim.expectedHash,
        detail: "Ownership marker is not independently authenticated and cannot authorize removal",
      });
    } else {
      const prior = priorUnmanaged.get((yield* physicalPath(observed.path)).key);
      state.unmanaged.push({
        harness: observed.harness,
        harnesses,
        path: observed.path,
        paths: [...observed.paths],
        currentHash,
        ...(prior ? { lastHash: prior.currentHash } : {}),
      });
    }
  }
  if (scanIssues.length) state.scanIssues = scanIssues;
  else delete state.scanIssues;
  return state;
});
