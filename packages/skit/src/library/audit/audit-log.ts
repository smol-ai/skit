import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join } from "node:path";
import { Digest } from "../../contracts.js";
import { OperationId, makeOperationId } from "../entity-ids.js";

export const LibraryAuditChange = Schema.Struct({
  entity: Schema.Literals([
    "collection",
    "skill",
    "version",
    "binding",
    "projection",
    "custody",
    "library",
  ]),
  id: Schema.String,
  action: Schema.String,
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  digest: Schema.optionalKey(Digest),
});
export interface LibraryAuditChange extends Schema.Schema.Type<typeof LibraryAuditChange> {}

export const LibraryAuditEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventId: OperationId,
  occurredAt: Schema.String,
  type: Schema.String,
  workflow: Schema.String,
  imported: Schema.optionalKey(Schema.Boolean),
  changes: Schema.Array(LibraryAuditChange),
});
export interface LibraryAuditEvent extends Schema.Schema.Type<typeof LibraryAuditEvent> {}

const AuditLine = Schema.fromJsonString(LibraryAuditEvent);
export type LibraryAuditDraft = Omit<LibraryAuditEvent, "eventId">;

export class LibraryAuditInvalid extends Schema.TaggedError<LibraryAuditInvalid>()(
  "LibraryAuditInvalid",
  { path: Schema.String, line: Schema.optionalKey(Schema.Number), cause: Schema.Defect() },
) {}

export interface LibraryAuditLogService {
  readonly append: (
    draft: LibraryAuditDraft,
  ) => Effect.Effect<LibraryAuditEvent, PlatformError | LibraryAuditInvalid>;
  readonly list: () => Effect.Effect<
    readonly LibraryAuditEvent[],
    PlatformError | LibraryAuditInvalid
  >;
}

export class LibraryAuditLog extends Context.Service<LibraryAuditLog, LibraryAuditLogService>()(
  "skit/library/LibraryAuditLog",
) {}

/** Append one event to a Library's history. The log and the store's own journal share this. */
export const appendLibraryAuditEffect = Effect.fn("LibraryAudit.append")(function* (
  home: string,
  draft: LibraryAuditDraft,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(home, "audit.jsonl");
  const event = yield* LibraryAuditEvent.makeEffect({
    ...draft,
    eventId: makeOperationId(),
  }).pipe(Effect.mapError((cause) => new LibraryAuditInvalid({ path, cause })));
  const encoded = yield* Schema.encodeEffect(AuditLine)(event).pipe(
    Effect.mapError((cause) => new LibraryAuditInvalid({ path, cause })),
  );
  yield* fs.writeFileString(path, `${encoded}\n`, { flag: "a", mode: 0o600 });
  return event;
});

export function libraryAuditLogLayer(options: { readonly home: string }) {
  return Layer.effect(
    LibraryAuditLog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = join(options.home, "audit.jsonl");
      const append = (draft: LibraryAuditDraft) =>
        appendLibraryAuditEffect(options.home, draft).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      const list = Effect.fn("LibraryAudit.list")(function* () {
        const text = yield* fs
          .readFileString(path)
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
            ),
          );
        const events: LibraryAuditEvent[] = [];
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (!line && index === lines.length - 1) continue;
          const event = yield* Schema.decodeUnknownEffect(AuditLine)(line).pipe(
            Effect.mapError((cause) => new LibraryAuditInvalid({ path, line: index + 1, cause })),
          );
          events.push(event);
        }
        return events;
      });
      return LibraryAuditLog.of({ append, list });
    }),
  );
}
