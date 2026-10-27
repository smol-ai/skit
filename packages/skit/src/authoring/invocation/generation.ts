import type { DescriptorFailure } from "../../failures.js";
import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join, posix, resolve } from "node:path";
import {
  COLLECTION_CONTROL_DIRECTORY,
  AUTHOR_WORKSPACE_METADATA_FILE,
} from "../../artifact/control-files.js";
import { InvocationPolicy } from "../../contracts.js";
import {
  applyHarnessInvocationPolicy,
  type HarnessInvocationWriteFailure,
} from "../../harnesses/projection.js";
import {
  AuthoredInvocationHarness,
  invocationMetadataAdapters,
} from "../../harnesses/invocation-metadata.js";
import { readSkitDescriptor } from "../../artifact/skit.js";
import { NotAnAuthorWorkspace } from "../../failures.js";

export const InvocationMetadataGeneration = Schema.Struct({
  skill: Schema.String,
  harness: AuthoredInvocationHarness,
  path: Schema.String,
  policy: InvocationPolicy,
  changed: Schema.Boolean,
});
export type InvocationMetadataGeneration = typeof InvocationMetadataGeneration.Type;

export function isAuthorWorkspace(
  root: string,
): Effect.Effect<boolean, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(
      join(root, COLLECTION_CONTROL_DIRECTORY, AUTHOR_WORKSPACE_METADATA_FILE),
    );
  });
}

export type InvocationMetadataGenerationFailure =
  | DescriptorFailure
  | NotAnAuthorWorkspace
  | HarnessInvocationWriteFailure;

/**
 * Write every declared invocation policy into the Skills' own native metadata. Generation is an
 * author-owned step: it rewrites files the author owns, so it runs only inside an Author Workspace
 * and never during validation, publication, synchronization, or acquisition.
 */
export function generateInvocationMetadata(
  root: string,
  options: { dryRun?: boolean } = {},
): Effect.Effect<
  InvocationMetadataGeneration[],
  InvocationMetadataGenerationFailure,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const absolute = resolve(root);
    if (!(yield* isAuthorWorkspace(absolute)))
      return yield* Effect.fail(new NotAnAuthorWorkspace({ path: absolute }));
    const descriptor = yield* readSkitDescriptor(absolute);
    const results: InvocationMetadataGeneration[] = [];
    for (const skill of descriptor.skills) {
      if (!skill.invocation) continue;
      const directory = join(absolute, ...skill.path.split("/"));
      for (const harness of AuthoredInvocationHarness.literals) {
        results.push({
          skill: skill.name,
          harness,
          path: posix.join(skill.path, invocationMetadataAdapters[harness].file),
          policy: skill.invocation,
          changed: yield* applyHarnessInvocationPolicy(directory, harness, skill.invocation, {
            dryRun: options.dryRun,
          }),
        });
      }
    }
    return results;
  });
}
