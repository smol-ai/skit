import { Schema, SchemaGetter } from "effect";
import {
  badArgument,
  isPlatformError,
  systemError,
  type PlatformError,
} from "effect/PlatformError";

const SystemErrorTags = Schema.Literals([
  "AlreadyExists",
  "BadResource",
  "Busy",
  "InvalidData",
  "NotFound",
  "PermissionDenied",
  "TimedOut",
  "UnexpectedEof",
  "Unknown",
  "WouldBlock",
  "WriteZero",
]);

/**
 * Effect's PlatformError, stored as the fields it exposes. Its `cause` can be any value, so it is
 * not stored; a read-back error has none.
 */
export const PlatformErrorSchema = Schema.TaggedStruct("PlatformError", {
  reason: Schema.Struct({
    _tag: Schema.Union([SystemErrorTags, Schema.Literal("BadArgument")]),
    module: Schema.String,
    method: Schema.String,
    description: Schema.optionalKey(Schema.String),
    syscall: Schema.optionalKey(Schema.String),
    pathOrDescriptor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  }),
}).pipe(
  Schema.decodeTo(Schema.declare(isPlatformError), {
    decode: SchemaGetter.transform(({ reason }) => {
      const { _tag, module, method, description, syscall, pathOrDescriptor } = reason;
      return _tag === "BadArgument"
        ? badArgument({ module, method, ...(description === undefined ? {} : { description }) })
        : systemError({
            _tag,
            module,
            method,
            ...(description === undefined ? {} : { description }),
            ...(syscall === undefined ? {} : { syscall }),
            ...(pathOrDescriptor === undefined ? {} : { pathOrDescriptor }),
          });
    }),
    encode: SchemaGetter.transform(({ reason }: PlatformError) => ({
      _tag: "PlatformError" as const,
      reason: {
        _tag: reason._tag,
        module: reason.module,
        method: reason.method,
        ...(reason.description === undefined ? {} : { description: reason.description }),
        ...(reason._tag === "BadArgument" || reason.syscall === undefined
          ? {}
          : { syscall: reason.syscall }),
        ...(reason._tag === "BadArgument" || reason.pathOrDescriptor === undefined
          ? {}
          : { pathOrDescriptor: reason.pathOrDescriptor }),
      },
    })),
  }),
);
