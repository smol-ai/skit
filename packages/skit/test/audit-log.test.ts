import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { LibraryAuditLog, libraryAuditLogLayer, skitLayer } from "../src/index.js";

it.effect("appends and reads validated JSONL events outside Library state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-log-" });
    const appended = yield* Effect.gen(function* () {
      const audit = yield* LibraryAuditLog;
      const event = yield* audit.append({
        schemaVersion: 1,
        type: "projection.disabled",
        workflow: "disable",
        occurredAt: "2026-09-17T00:00:00.000Z",
        changes: [{ entity: "projection", id: "projection_1", action: "disabled" }],
      });
      expect(yield* audit.list()).toEqual([event]);
      return event;
    }).pipe(Effect.provide(libraryAuditLogLayer({ home })));

    expect(appended.type).toBe("projection.disabled");
    expect(yield* fs.exists(join(home, "state.json"))).toBe(false);
    expect(yield* fs.exists(join(home, "audit.jsonl"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("reports the malformed JSONL line", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-log-invalid-" });
    yield* fs.writeFileString(join(home, "audit.jsonl"), "{}\n");
    const failure = yield* Effect.gen(function* () {
      return yield* (yield* LibraryAuditLog).list();
    }).pipe(Effect.provide(libraryAuditLogLayer({ home })), Effect.flip);
    expect(failure).toMatchObject({ _tag: "LibraryAuditInvalid", line: 1 });
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
