import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { dirname, join } from "node:path";

import type { HarnessName, InvocationPolicy } from "../contracts.js";
import { HarnessMetadataInvalid, ProjectionFileMissing } from "../failures.js";
import {
  expectedNativeInvocation,
  invocationMetadataAdapters,
  type InvocationHarness,
} from "./invocation-metadata.js";

export type HarnessInvocationWriteFailure =
  | HarnessMetadataInvalid
  | ProjectionFileMissing
  | PlatformError;

export type HarnessInvocationPolicy =
  | { source: "declared"; policy: InvocationPolicy }
  | { source: "override"; policy: InvocationPolicy };

function invocationAdapterFor(harness: HarnessName) {
  return Object.hasOwn(invocationMetadataAdapters, harness)
    ? invocationMetadataAdapters[harness as InvocationHarness]
    : undefined;
}

/**
 * Write a Harness's native invocation metadata for one Skill directory. A published artifact
 * already satisfies its declaration, so a `declared` policy normally finds nothing to change;
 * an `override` is the device-local decision and always wins over what the artifact carries.
 *
 * Returns true when the directory changed, or would change under `dryRun`.
 */
export function applyHarnessInvocationPolicyEffect(
  directory: string,
  harness: HarnessName,
  policy: HarnessInvocationPolicy,
  options: { dryRun?: boolean } = {},
): Effect.Effect<boolean, HarnessInvocationWriteFailure, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const adapter = invocationAdapterFor(harness);
    if (!adapter) return false;
    const path = join(directory, ...adapter.file.split("/"));
    // A missing file is normal unless the adapter requires it; every other read failure is real.
    const text = yield* fs
      .readFileString(path)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (text === undefined && adapter.required)
      return yield* Effect.fail(new ProjectionFileMissing({ path }));
    const next = yield* Effect.fromResult(
      adapter.write(text, expectedNativeInvocation(adapter.harness, policy.policy), path),
    );
    if (next === null) {
      if (text === undefined) return false;
      if (!options.dryRun) yield* fs.remove(path);
      return true;
    }
    if (next === text) return false;
    if (!options.dryRun) {
      yield* fs.makeDirectory(dirname(path), { recursive: true });
      yield* fs.writeFileString(path, next);
    }
    return true;
  });
}
