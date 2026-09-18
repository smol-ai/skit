import { Cause, Deferred, Effect, Fiber, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { systemError } from "effect/PlatformError";
import { skitLayer } from "@smolai/skit-core";
import { expect } from "vitest";
import {
  RegistryOriginInvalid,
  type AuthorRemoteMetadataInvalid,
  type CredentialsUnusable,
} from "../src/registry/failures.js";
import { readAuthorRemoteEffect } from "../src/workflows/author/sync.js";
import { readConfigEffect, resolveAuthForOriginEffect } from "../src/registry/auth.js";

const remote = readAuthorRemoteEffect("/author");
const config = readConfigEffect("/auth");

it.effect.each(["remote", "config"] as const)(
  "%s read preserves defects and interruption",
  (helper) =>
    Effect.gen(function* () {
      const operation: Effect.Effect<
        void,
        AuthorRemoteMetadataInvalid | CredentialsUnusable,
        FileSystem.FileSystem
      > = helper === "remote" ? remote.pipe(Effect.asVoid) : config.pipe(Effect.asVoid);
      // The effect signals readiness through an unsafe completion so the whole test can stay
      // inside one runtime instead of awaiting a raw Promise from outside it.
      const ready = Deferred.makeUnsafe<void>();
      const reached = () => Deferred.doneUnsafe(ready, Effect.void);
      let finalized = false;
      const read = Effect.sync(reached).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            finalized = true;
          }),
        ),
      );
      const injected = (readFileString: FileSystem.FileSystem["readFileString"]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* operation.pipe(
            Effect.provideService(FileSystem.FileSystem, { ...fs, readFileString }),
          );
        }).pipe(Effect.provide(skitLayer));
      const defect = yield* injected(() => Effect.die("programming defect")).pipe(Effect.exit);
      expect(defect._tag).toBe("Failure");
      if (defect._tag === "Failure") {
        expect(Cause.hasDies(defect.cause)).toBe(true);
        expect(Cause.hasFails(defect.cause)).toBe(false);
      }
      const fiber = yield* Effect.forkChild(injected(() => read));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(exit._tag).toBe("Failure");
          if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          expect(finalized).toBe(true);
        }),
        Fiber.interrupt(fiber),
      );
    }),
);

it.effect.each(["remote", "config"] as const)(
  "%s read retains legacy I/O and malformed-value classifications",
  (helper) =>
    Effect.gen(function* () {
      const operation: Effect.Effect<
        void,
        AuthorRemoteMetadataInvalid | CredentialsUnusable,
        FileSystem.FileSystem
      > = helper === "remote" ? remote.pipe(Effect.asVoid) : config.pipe(Effect.asVoid);
      for (const input of [
        Effect.succeed("null"),
        Effect.fail(
          systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: "/test",
            cause: Object.assign(new Error("denied"), { code: "EACCES" }),
          }),
        ),
      ]) {
        const exit = yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* operation.pipe(
            Effect.provideService(FileSystem.FileSystem, { ...fs, readFileString: () => input }),
          );
        }).pipe(Effect.provide(skitLayer), Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(Cause.hasDies(exit.cause)).toBe(false);
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: helper === "remote" ? "AuthorRemoteMetadataInvalid" : "CredentialsUnusable",
          });
        }
      }
    }),
);

it.effect("origin parsing fails in the named Registry channel", () =>
  Effect.gen(function* () {
    const exit = yield* resolveAuthForOriginEffect("not a URL").pipe(
      Effect.provide(skitLayer),
      Effect.exit,
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toBeInstanceOf(RegistryOriginInvalid);
    }
  }),
);
