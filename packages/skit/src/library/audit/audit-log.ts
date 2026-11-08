import { writeRawAtomic, syncPaths } from "../../platform/atomic-write.js";
import { canonicalJson } from "../../shared/json.js";
import { Data, Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { Hash } from "../../shared/hash.js";
import { OperationId } from "../entity-ids.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

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
  digest: Schema.optionalKey(Hash),
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

export class LibraryAuditInvalid
  extends Data.TaggedError("LibraryAuditInvalid")<{
    path: string;
    line?: number;
    cause: unknown;
  }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  get remediation(): string {
    return `Move ${this.path} aside to start a new audit log, then retry.`;
  }
  get message(): string {
    return `Invalid Library audit log at ${this.path}${this.line === undefined ? "" : `:${this.line}`}`;
  }
}

/** Deliver a recorded identity once; atomic replacement cannot leave a partial JSONL tail. */
export const appendLibraryAudit = Effect.fn("LibraryAudit.append")(function* (
  home: string,
  recorded: LibraryAuditEvent,
) {
  const path = join(home, "audit.jsonl");
  const event = yield* LibraryAuditEvent.makeEffect(recorded).pipe(
    Effect.mapError((cause) => new LibraryAuditInvalid({ path, cause })),
  );
  const { events: previous, text } = yield* readAuditContents(home);
  const delivered = previous.find((item) => item.eventId === event.eventId);
  if (delivered) {
    if (canonicalJson(delivered) !== canonicalJson(event))
      return yield* new LibraryAuditInvalid({
        path,
        cause: "Recorded event differs from its delivered identity",
      });
    yield* syncPaths([path, home]);
    return delivered;
  }
  const encoded = yield* Schema.encodeEffect(AuditLine)(event).pipe(
    Effect.mapError((cause) => new LibraryAuditInvalid({ path, cause })),
  );
  const separator = text.length && !text.endsWith("\n") ? "\n" : "";
  yield* writeRawAtomic(path, `${text}${separator}${encoded}\n`);
  // The state-file acknowledgement may become durable only after this event and its name do.
  yield* syncPaths([path, home]);
  return event;
});

const readAuditContents = Effect.fn("LibraryAudit.readContents")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = join(home, "audit.jsonl");
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
    const event = yield* Schema.decodeEffect(AuditLine)(line).pipe(
      Effect.mapError((cause) => new LibraryAuditInvalid({ path, line: index + 1, cause })),
    );
    events.push(event);
  }
  return { text, events };
});

export const readLibraryAudit = Effect.fn("LibraryAudit.list")(function* (home: string) {
  return (yield* readAuditContents(home)).events;
});
