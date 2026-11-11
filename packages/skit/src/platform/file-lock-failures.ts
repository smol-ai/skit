import { Predicate, Schema, SchemaGetter } from "effect";

/** Serialization runs only when a lock failure crosses a JSON boundary. Live causes stay intact.
 * Effect's defect codec retains native Error text/cause; enumerable driver fields retain codes.
 * Unsupported JavaScript values follow Effect's documented defect serialization policy. */
export const FileLockFailureCause = Schema.Struct({
  error: Schema.Defect(),
  properties: Schema.Record(Schema.String, Schema.Defect()),
}).pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(({ error, properties }) =>
      Predicate.isObject(error)
        ? Object.defineProperties(error, Object.getOwnPropertyDescriptors(properties))
        : error,
    ),
    encode: SchemaGetter.transform((cause: unknown) => ({
      error: cause,
      properties: Predicate.isObject(cause) ? Object.fromEntries(Object.entries(cause)) : {},
    })),
  }),
);
export type FileLockFailureCause = typeof FileLockFailureCause.Type;

export class FileLockBusy extends Schema.TaggedError<
  FileLockBusy,
  { readonly brand: unique symbol }
>()("FileLockBusy", {
  path: Schema.String,
}) {}
export class FileLockFailed extends Schema.TaggedError<
  FileLockFailed,
  { readonly brand: unique symbol }
>()("FileLockFailed", {
  path: Schema.String,
  cause: FileLockFailureCause,
}) {}
