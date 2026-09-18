// The generated wrapper's copy must belong to the acquisition Scope.
//
// Normalizing a bare Agent Skills directory stages it under the acquisition workspace. That copy
// used to be one recursive `fs.copy`: an interrupt released the workspace while the copy was
// still running, so writes could land after the tree had been removed. It now goes through the
// shared owned-copy primitive, which settles each namespace change and each file handle.
//
// These drive the real resolver against real temporary directories and inspect the filesystem
// after finalization, rather than asserting on which copy helper was called.

import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem } from "effect";
import { join, sep } from "node:path";
import { resolveSkitSourceEffect } from "../src/acquisition/sources.js";
import { skitLayer } from "../src/platform/layer.js";

const SKILL = `---\nname: Review Notes\ndescription: A skill\n---\n\n# Review Notes\n`;

/** A bare Agent Skills directory: no descriptor, so acquisition generates a wrapper. */
const bareSkill = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-wrapper-" });
  const skill = join(root, "review-notes");
  yield* fs.makeDirectory(skill, { recursive: true });
  yield* fs.writeFileString(join(skill, "SKILL.md"), SKILL);
  return { fs, root, skill };
});

describe("the generated wrapper copy", () => {
  it.effect("preserves modes and symlinks verbatim", () =>
    Effect.gen(function* () {
      const { fs, skill } = yield* bareSkill;
      yield* fs.writeFileString(join(skill, "run.sh"), "#!/bin/sh\n");
      yield* fs.chmod(join(skill, "run.sh"), 0o755);
      yield* fs.symlink("SKILL.md", join(skill, "alias.md"));
      const staged = yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolveSkitSourceEffect(skill);
          const copied = join(resolved.root, "skills");
          const [name] = yield* fs.readDirectory(copied);
          const directory = join(copied, name);
          return {
            // Read inside the Scope: the workspace is gone once it closes.
            entries: (yield* fs.readDirectory(directory)).sort(),
            mode: (yield* fs.stat(join(directory, "run.sh"))).mode & 0o777,
            link: yield* fs.readLink(join(directory, "alias.md")),
            originalRoot: resolved.originalRoot,
          };
        }),
      );
      assert.deepStrictEqual(staged.entries, ["SKILL.md", "alias.md", "run.sh"]);
      assert.strictEqual(staged.mode, 0o755, "the executable bit must survive normalization");
      assert.strictEqual(staged.link, "SKILL.md", "a relative link must not be resolved");
      // The Original stays the caller's own tree; only the normalized wrapper is staged.
      assert.strictEqual(staged.originalRoot, skill);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.live("releases the workspace on interruption without a late write recreating it", () =>
    Effect.gen(function* () {
      const { fs, skill } = yield* bareSkill;
      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));
      // Enough files that an abandoned recursive copy would still have work left to do.
      for (let index = 0; index < 40; index++)
        yield* fs.writeFileString(join(skill, `note-${index}.md`), "x".repeat(4096));
      const reached = yield* Deferred.make<string>();
      const gated = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* resolveSkitSourceEffect(skill).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            open: (path: string, options?: Parameters<typeof fs.open>[1]) =>
              path.includes(`${sep}agent-skills-skit${sep}skills${sep}`) && options?.flag === "wx"
                ? Effect.gen(function* () {
                    // The workspace is the ancestor of the generated wrapper root.
                    yield* Deferred.succeed(
                      reached,
                      path.slice(0, path.indexOf(`${sep}agent-skills-skit${sep}`)),
                    );
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
        yield* exists(join(workspace, "agent-skills-skit")),
        "the wrapper root exists while the copy is gated",
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
