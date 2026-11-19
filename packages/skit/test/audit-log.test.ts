import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { makeOperationId } from "../src/library/entity-ids.js";
import { skitLayer } from "../src/platform/layer.js";
import {
  migrateLocalLibraryState,
  inspectLocalLibraryState,
} from "../src/library/store/state-file.js";
import { readLibraryAudit } from "../src/library/audit/audit-log.js";

it.effect("imports and reads historical audit without inventing domain state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-log-" });
    const event = {
      schemaVersion: 1,
      eventId: makeOperationId(),
      type: "projection.disabled",
      workflow: "disable",
      occurredAt: "2026-09-17T00:00:00.000Z",
      changes: [{ entity: "projection", id: "projection_1", action: "disabled" }],
    };
    yield* fs.writeFileString(join(home, "audit.jsonl"), JSON.stringify(event));
    yield* migrateLocalLibraryState(home);
    expect(yield* readLibraryAudit(home)).toEqual([event]);
    expect((yield* inspectLocalLibraryState(home)).present).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("reports the malformed JSONL line", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-audit-log-invalid-" });
    yield* fs.writeFileString(join(home, "audit.jsonl"), "{}\n");
    const failure = yield* Effect.suspend(() => migrateLocalLibraryState(home)).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "LibraryAuditInvalid", line: 1 });
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);

it.effect("imports historical events once and deduplicates only an identical event", () =>
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
    const second = { ...first, eventId: makeOperationId(), type: "binding.disabled" };
    const previous = JSON.stringify({ ...first, historicalExtension: "preserve this" });
    const source = [previous, JSON.stringify(second), JSON.stringify(second)].join("\n");
    yield* fs.writeFileString(join(home, "audit.jsonl"), source);
    yield* migrateLocalLibraryState(home);
    const events = yield* readLibraryAudit(home);
    expect(events).toEqual([first, second]);
    yield* migrateLocalLibraryState(home);
    expect(yield* readLibraryAudit(home)).toEqual(events);
    expect(yield* fs.readFileString(join(home, "audit.jsonl"))).toBe(source);
    const conflicting = join(home, "conflicting-import");
    yield* fs.makeDirectory(conflicting);
    yield* fs.writeFileString(
      join(conflicting, "audit.jsonl"),
      [previous, JSON.stringify({ ...first, workflow: "changed" })].join("\n"),
    );
    const failure = yield* Effect.flip(migrateLocalLibraryState(conflicting));
    expect(failure._tag).toBe("LibraryAuditInvalid");
    if (failure._tag === "LibraryAuditInvalid")
      expect(failure.reason._tag).toBe("EventIdentityChanged");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
