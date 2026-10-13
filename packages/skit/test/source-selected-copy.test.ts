// The staged copy of selected Git members must belong to the acquisition Scope.
//
// Selecting Skills from a Git checkout stages them under the acquisition workspace. A recursive
// `fs.copy` there is one interruptible operation: an interrupt released the workspace while the
// copy was still running, so writes could land after the tree had been removed. It goes through
// the shared owned-copy primitive, which settles each namespace change and each file handle.
//
// These drive the real resolver against real temporary repositories and inspect the filesystem
// after finalization, rather than asserting on which copy helper was called.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { skitLayer } from "../src/platform/layer.js";

const SKILL = `---\nname: Review Notes\ndescription: A skill\n---\n\n# Review Notes\n`;

/** A repository with one Skill directory, selected as a locked member. */
const selectedSkill = (
  populate: (fs: FileSystem.FileSystem, skill: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-selected-copy-" });
    const skill = join(root, "review-notes");
    yield* fs.makeDirectory(skill, { recursive: true });
    yield* fs.writeFileString(join(skill, "SKILL.md"), SKILL);
    yield* populate(fs, skill);
    yield* Effect.sync(() => {
      for (const args of [
        ["init", "-q"],
        ["add", "."],
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "skill"],
      ])
        execFileSync("git", args, { cwd: root });
    });
    return {
      fs,
      source: { type: "git" as const, remote: root, skillDirectories: ["review-notes"] },
    };
  });

describe("the selected Git member copy", () => {
  it.effect("preserves modes and symlinks verbatim", () =>
    Effect.gen(function* () {
      const { fs, source } = yield* selectedSkill((fs, skill) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(join(skill, "run.sh"), "#!/bin/sh\n");
          yield* fs.chmod(join(skill, "run.sh"), 0o755);
          yield* fs.symlink("SKILL.md", join(skill, "alias.md"));
        }).pipe(Effect.orDie),
      );
      const staged = yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolveSkitSourceEffect(source);
          const directory = join(resolved.originalRoot, "review-notes");
          return {
            // Read inside the Scope: the workspace is gone once it closes.
            entries: (yield* fs.readDirectory(directory)).sort(),
            mode: (yield* fs.stat(join(directory, "run.sh"))).mode & 0o777,
            link: yield* fs.readLink(join(directory, "alias.md")),
          };
        }),
      );
      assert.deepStrictEqual(staged.entries, ["SKILL.md", "alias.md", "run.sh"]);
      assert.strictEqual(staged.mode, 0o755, "the executable bit must survive staging");
      assert.strictEqual(staged.link, "SKILL.md", "a relative link must not be resolved");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.live("releases the workspace on interruption without a late write recreating it", () =>
    Effect.gen(function* () {
      const { fs, source } = yield* selectedSkill((fs, skill) =>
        // Enough files that an abandoned recursive copy would still have work left to do.
        Effect.forEach(
          Array.from({ length: 40 }, (_, index) => join(skill, `note-${index}.md`)),
          (path) => fs.writeFileString(path, "x".repeat(4096)),
          { discard: true },
        ).pipe(Effect.orDie),
      );
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
      const reached = yield* Deferred.make<string>();
      const staging = `${sep}git-selected-original${sep}`;
      const gated = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* resolveSkitSourceEffect(source).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
              path.includes(staging) && options?.flag === "wx"
                ? Effect.gen(function* () {
                    // The workspace is the ancestor of the staged copy.
                    yield* Deferred.succeed(reached, path.slice(0, path.indexOf(staging)));
                    // Stall inside the copy so the interrupt lands mid-tree.
                    return yield* Effect.never;
                  })
                : fs.open(path, options),
          }),
        );
      });

      const fiber = yield* Effect.forkChild(Effect.scoped(gated));
      const workspace = yield* Deferred.await(reached);
      assert.isTrue(
        yield* exists(join(workspace, "git-selected-original")),
        "the staged root exists while the copy is gated",
      );
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        "the fiber is interrupted rather than failing",
      );

      // Finalization has already completed: awaiting the fiber awaits its finalizers.
      assert.isFalse(yield* exists(workspace), "the acquisition workspace must be removed");
      yield* Effect.sleep(150);
      assert.isFalse(yield* exists(workspace), "no abandoned copy may recreate the workspace");
    }).pipe(Effect.provide(skitLayer)),
  );
});
