import { skitLayer } from "../src/platform/layer.js";
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { join } from "node:path";
import { expect } from "vitest";
import { emptyLibraryState } from "../src/library/library-state.js";
import { libraryDoctorReport } from "../src/library/inventory/doctor-report.js";
import { scanInventory } from "../src/library/inventory/refresh.js";
import {
  makeCollectionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
} from "../src/library/entity-ids.js";
const nativeLibraryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-inventory-scan-" });
  const home = join(root, "home");
  yield* fs.makeDirectory(home);
  return { root, home };
});

it.effect(
  "reports skill copies, shared symlinks and scan gaps without counting arbitrary directories",
  () =>
    Effect.gen(function* () {
      const f = yield* nativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const root = join(f.root, "codex");
      const claude = join(f.root, "claude");
      const denied = join(f.root, "denied");
      const skill = join(root, "review");
      yield* fs.makeDirectory(skill, { recursive: true });
      yield* fs.writeFileString(join(skill, "SKILL.md"), "review");
      yield* fs.makeDirectory(join(root, "not-a-skill"));
      yield* fs.makeDirectory(claude);
      const alias = join(claude, "review");
      yield* fs.symlink(skill, alias);
      const missing = join(f.root, "missing");
      const broken = join(root, "broken");
      yield* fs.symlink("../missing", broken);
      const before = emptyLibraryState();
      const observed = yield* scanInventory(before, [
        { harness: "codex", root },
        { harness: "claude-code", root: claude },
        { harness: "opencode", root: denied },
        { harness: "devin", root: join(f.root, "absent") },
      ]).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: (path) =>
            path === denied
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: path,
                  }),
                )
              : fs.readDirectory(path),
        }),
      );
      expect(observed.unmanaged).toHaveLength(1);
      expect(observed.unmanaged[0].paths).toEqual([skill, alias]);
      expect(observed.unmanaged[0].harness).toBe("codex");
      expect(observed.unmanaged[0].harnesses).toEqual(["claude-code", "codex"]);
      expect(observed.scanIssues?.map((issue) => issue.code)).toEqual([
        "DANGLING_SYMLINK",
        "UNREADABLE_PATH",
        "MISSING_ROOT",
      ]);
      expect(observed.scanIssues).toContainEqual({
        code: "DANGLING_SYMLINK",
        harness: "codex",
        path: broken,
        target: missing,
      });
      expect(libraryDoctorReport(observed).issues).toEqual([
        expect.objectContaining({ code: "UNREADABLE_PATH", path: denied }),
      ]);
      expect(yield* fs.exists(join(f.home, "state.json"))).toBe(false);
      expect(yield* fs.readFileString(join(skill, "SKILL.md"))).toBe("review");
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect.each([true, false])(
  "observes a symlinked ownership claim without SKILL.md (valid: %s)",
  (valid) =>
    Effect.gen(function* () {
      const f = yield* nativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const root = join(f.root, "codex");
      const target = join(f.root, "claimed");
      yield* fs.makeDirectory(root);
      yield* fs.makeDirectory(target);
      const marker = JSON.stringify(
        valid
          ? {
              schemaVersion: 2,
              projectionPolicyVersion: 1,
              projection_id: makeInstalledSkillId(),
              collection_id: makeCollectionId(),
              skill_id: makeSkillId(),
              skill_version_id: makeSkillVersionId(),
              expected_digest: `sha256:${"a".repeat(64)}`,
              harness: "codex",
            }
          : {},
      );
      yield* fs.writeFileString(join(target, ".skit-ownership.json"), marker);
      const path = join(root, "review");
      yield* fs.symlink(target, path);
      const state = emptyLibraryState();
      const observed = yield* scanInventory(state, [{ harness: "codex", root }]);
      expect(observed.unmanaged).toEqual([]);
      expect(observed.ownershipIssues).toMatchObject([
        { path, code: valid ? "ORPHANED_OWNERSHIP_MARKER" : "INVALID_OWNERSHIP_MARKER" },
      ]);
      expect(yield* fs.readFileString(join(target, ".skit-ownership.json"))).toBe(marker);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect(
  "preserves scan issues outside a refreshed root and clears resolved issues inside it",
  () =>
    Effect.gen(function* () {
      const f = yield* nativeLibraryFixture;
      const fs = yield* FileSystem.FileSystem;
      const root = join(f.root, "codex");
      yield* fs.makeDirectory(root);
      const state = emptyLibraryState();
      const outside = {
        path: join(f.root, "elsewhere"),
        harness: "opencode" as const,
        code: "UNREADABLE_PATH" as const,
      };
      state.scanIssues = [outside, { path: root, harness: "codex", code: "UNREADABLE_PATH" }];
      const observed = yield* scanInventory(state, [{ root, harness: "codex" }]);
      expect(observed.scanIssues).toEqual([outside]);
      expect(
        (yield* scanInventory({ ...state, scanIssues: [state.scanIssues[1]] }, [
          { root, harness: "codex" },
        ])).scanIssues,
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
