import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { Effect, Logger, References } from "effect";
import { systemError } from "effect/PlatformError";
import { LibraryRecoveryNotice } from "@smolai/skit-core/library";
import { makeOperationId } from "@smolai/skit-core/universal/consumer";
import { PnpmEvidenceUnreadable } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { tuiLogger } from "../src/library/logging";

it.effect("TUI logs explain every notice and retain the native logger context", () =>
  Effect.gen(function* () {
    const home = "/tmp/skit library";
    const failure = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: home,
    });
    const operationId = makeOperationId();
    const notices = [
      LibraryRecoveryNotice.cases.PendingStateSaveFailed.make({ home, failure }),
      LibraryRecoveryNotice.cases.BackupsStillPending.make({
        home,
        installedSkillId: "installed-review",
        path: "/tmp/skills/review",
        failure,
      }),
      LibraryRecoveryNotice.cases.SetupStopNotRecorded.make({ home, operationId, failure }),
      LibraryRecoveryNotice.cases.HistoryDeliveryPending.make({ home, failure }),
    ];
    const incoming: Logger.Options<unknown>[] = [];
    const forwarded: Logger.Options<unknown>[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(Logger.defaultLogger, "log").mockImplementation((options) => {
          forwarded.push(options);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const probe = Logger.make((options) => {
      incoming.push(options);
      tuiLogger.log(options);
    });
    for (const notice of notices)
      yield* Effect.logWarning(notice).pipe(Effect.provide(Logger.layer([probe])));
    yield* Effect.logDebug(PnpmEvidenceUnreadable.make({ path: home, failure })).pipe(
      Effect.provide(Logger.layer([probe])),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    );
    expect(forwarded).toHaveLength(5);
    for (const [index, entry] of forwarded.entries()) {
      expect(entry.fiber).toBe(incoming[index]!.fiber);
      expect(entry.date).toBe(incoming[index]!.date);
      expect(entry.cause).toBe(incoming[index]!.cause);
      expect(entry.logLevel).toBe(incoming[index]!.logLevel);
      expect(entry.message).toContain(failure);
      const text = Array.isArray(entry.message)
        ? entry.message.filter((value) => typeof value === "string").join("")
        : "";
      expect(text).toContain(home);
      expect(text).not.toContain('"_tag"');
    }
  }).pipe(Effect.scoped),
);
