import { findDuplicates, type DuplicateScanError } from "../src/library/duplicates.js";
import { skitLayer } from "../src/platform/layer.js";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, FileSystem } from "effect";

it.effect(
  "an over-limit duplicate scan retains the observed count and refuses before inspecting children",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = "/scan/too-many";
      const errors: DuplicateScanError[] = [];
      const filesystem: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (path, options) =>
          path === root
            ? Effect.succeed(Array.from({ length: 4097 }, (_, index) => `skill-${index}`))
            : fs.readDirectory(path, options),
      };
      const failure = yield* Effect.flip(
        findDuplicates(
          {
            destinations: [{ destination: "agents", root }],
            readable: [{ harness: "codex", root }],
          },
          ["review"],
          errors,
        ).pipe(Effect.provideService(FileSystem.FileSystem, filesystem)),
      );
      expect(failure).toMatchObject({
        _tag: "DuplicateScanIncomplete",
        path: root,
        reason: { _tag: "EntryLimitExceeded", limit: 4096, count: 4097 },
      });
      expect(errors).toEqual([
        { path: root, reason: { _tag: "EntryLimitExceeded", limit: 4096, count: 4097 } },
      ]);
    }).pipe(Effect.provide(skitLayer)),
);
