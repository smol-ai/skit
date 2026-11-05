import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { makeOperationId } from "../src/library/entity-ids.js";
import { skitLayer } from "../src/platform/layer.js";
import { appendLibraryAudit, readLibraryAudit } from "../src/library/audit/audit-log.js";

it.effect("appends and reads validated JSONL events outside Library state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-log-" });
    const appended = yield* Effect.gen(function* () {
      const event = yield* appendLibraryAudit(home, {
        schemaVersion: 1,
        eventId: makeOperationId(),
        type: "projection.disabled",
        workflow: "disable",
        occurredAt: "2026-09-17T00:00:00.000Z",
        changes: [{ entity: "projection", id: "projection_1", action: "disabled" }],
      });
      expect(yield* readLibraryAudit(home)).toEqual([event]);
      return event;
    });

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
      return yield* readLibraryAudit(home);
    }).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "LibraryAuditInvalid", line: 1 });
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("delivery preserves existing event bytes and deduplicates only an identical event", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-delivery-" });
    const first = {
      schemaVersion: 1 as const,
      eventId: makeOperationId(),
      type: "binding.enabled",
      workflow: "test",
      occurredAt: "2026-11-05T00:00:00.000Z",
      changes: [],
    };
    const previous = JSON.stringify({ ...first, historicalExtension: "preserve this" });
    yield* fs.writeFileString(join(home, "audit.jsonl"), previous);
    const second = { ...first, eventId: makeOperationId(), type: "binding.disabled" };
    yield* appendLibraryAudit(home, second);
    const text = yield* fs.readFileString(join(home, "audit.jsonl"));
    expect(text.startsWith(`${previous}\n`)).toBe(true);
    yield* appendLibraryAudit(home, second);
    expect(yield* fs.readFileString(join(home, "audit.jsonl"))).toBe(text);
    expect(
      (yield* Effect.flip(appendLibraryAudit(home, { ...second, workflow: "different" })))._tag,
    ).toBe("LibraryAuditInvalid");
    expect(yield* fs.readFileString(join(home, "audit.jsonl"))).toBe(text);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
