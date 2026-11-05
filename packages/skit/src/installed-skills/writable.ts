import { Effect, FileSystem, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SkillsDirectoryNotWritable } from "./failures.js";
import { installedSkillStagingDirectory } from "./backups.js";

/**
 * Whether the operating system refused access. Node's EACCES arrives as `PermissionDenied`, but a
 * macOS sandbox profile (the one Codex uses) refuses with EPERM, which Effect reports as `Unknown`
 * carrying the original errno in its cause.
 */
const isPermissionDenied = (error: PlatformError): boolean =>
  error.reason._tag === "PermissionDenied" ||
  (error.reason._tag === "Unknown" &&
    Predicate.hasProperty(error.reason.cause, "code") &&
    (error.reason.cause.code === "EPERM" || error.reason.cause.code === "EROFS"));

/**
 * Prove that SKIT can place Installed Skills under a root: create the root and a scratch directory
 * in each place installing writes, the root itself and the staging directory where folders are
 * staged and backed up. A refusal becomes `SkillsDirectoryNotWritable` naming the root.
 * The recorded executor proves writability before saving enablement; its recovery program is
 * already durable. Installing checks again, so later refusals keep the same typed diagnostic.
 */
export const ensureSkillsDirectoryWritable = Effect.fn("Install.ensureSkillsDirectoryWritable")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    for (const directory of new Set([root, yield* installedSkillStagingDirectory(root)])) {
      const probe = yield* fs.makeTempDirectory({ directory, prefix: ".skit-write-check-" });
      yield* fs.remove(probe, { recursive: true });
    }
  },
  (effect, root) =>
    effect.pipe(
      Effect.catchTag(
        "PlatformError",
        (error): Effect.Effect<never, PlatformError | SkillsDirectoryNotWritable> =>
          Effect.fail(isPermissionDenied(error) ? new SkillsDirectoryNotWritable({ root }) : error),
      ),
    ),
);
