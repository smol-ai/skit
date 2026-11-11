import { writeRawAtomic, syncPaths } from "../../platform/atomic-write.js";
import { canonicalJson } from "../../shared/json.js";
import { Effect, FileSystem, Schema } from "effect";
import { join } from "node:path";
import { LibraryAuditEvent } from "./contracts.js";
export { LibraryAuditChange, LibraryAuditEvent } from "./contracts.js";
import { LibraryAuditInvalid } from "./failures.js";
export { LibraryAuditInvalid } from "./failures.js";

const AuditLine = Schema.fromJsonString(LibraryAuditEvent);

/** Deliver a recorded identity once; atomic replacement cannot leave a partial JSONL tail. */
export const appendLibraryAudit = Effect.fn("LibraryAudit.append")(function* (
  home: string,
  recorded: LibraryAuditEvent,
) {
  const path = join(home, "audit.jsonl");
  const event = yield* LibraryAuditEvent.makeEffect(recorded).pipe(
    Effect.mapError(
      (issue) =>
        new LibraryAuditInvalid({
          path,
          reason: { _tag: "SchemaInvalid", failure: new Schema.SchemaError(issue) },
        }),
    ),
  );
  const { events: previous, text } = yield* readAuditContents(home);
  const delivered = previous.find((item) => item.eventId === event.eventId);
  if (delivered) {
    if (canonicalJson(delivered) !== canonicalJson(event))
      return yield* new LibraryAuditInvalid({
        path,
        reason: {
          _tag: "EventIdentityChanged",
          eventId: event.eventId,
          expected: delivered,
          actual: event,
        },
      });
    yield* syncPaths([path, home]);
    return delivered;
  }
  const encoded = yield* Schema.encodeEffect(AuditLine)(event).pipe(
    Effect.mapError(
      (failure) => new LibraryAuditInvalid({ path, reason: { _tag: "SchemaInvalid", failure } }),
    ),
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
      Effect.mapError(
        (failure) =>
          new LibraryAuditInvalid({
            path,
            line: index + 1,
            reason: { _tag: "SchemaInvalid", failure },
          }),
      ),
    );
    events.push(event);
  }
  return { text, events };
});

export const readLibraryAudit = Effect.fn("LibraryAudit.list")(function* (home: string) {
  return (yield* readAuditContents(home)).events;
});
