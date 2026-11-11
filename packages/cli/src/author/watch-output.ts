import { Schema } from "effect";
import { AuthorWatchEvent, AuthorWatchRetrying } from "@smolai/skit-core/author";
import { RegistryFailure } from "../registry/failures.js";
import { RegistryRequestFailure } from "../registry/request-failures.js";

/** The CLI knows its Registry errors; core's protocol still accepts native transport failures. */
export const AuthorWatchOutput = Schema.Union([
  AuthorWatchRetrying.pipe(
    Schema.fieldsAssign({
      failure: Schema.toCodecJson(Schema.Union([RegistryFailure, RegistryRequestFailure])),
    }),
  ),
  AuthorWatchEvent,
]).pipe(
  // A constructor must keep live retry causes, rather than trying class defaults in the union.
  Schema.decodeTo(Schema.declare(Schema.is(AuthorWatchEvent))),
);
