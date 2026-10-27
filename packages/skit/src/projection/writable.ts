import { Effect, FileSystem, Predicate } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ProjectionRootNotWritable } from "../failures.js";
import { projectionWorkDirectoryEffect } from "./backups.js";

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
 * Prove that SKIT can place copies under a root: create the root and a scratch directory in each
 * place materializing writes, the root itself and the work directory where copies are staged and
 * backed up. A refusal becomes `ProjectionRootNotWritable` naming the root. Callers run this before
 * publishing Library state, so a sandboxed or read-only root fails without leaving a half-applied
 * Library behind; materializing runs it again, so every copy write fails the same way.
 */
export const ensureProjectionRootWritable = Effect.fn("Projection.ensureRootWritable")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    for (const directory of new Set([root, yield* projectionWorkDirectoryEffect(root)])) {
      const probe = yield* fs.makeTempDirectory({ directory, prefix: ".skit-write-check-" });
      yield* fs.remove(probe, { recursive: true });
    }
  },
  (effect, root) =>
    effect.pipe(
      Effect.catchTag(
        "PlatformError",
        (error): Effect.Effect<never, PlatformError | ProjectionRootNotWritable> =>
          Effect.fail(isPermissionDenied(error) ? new ProjectionRootNotWritable({ root }) : error),
      ),
    ),
);
