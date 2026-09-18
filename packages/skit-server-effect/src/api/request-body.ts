import { Effect, Schema, Stream } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";

export class RequestBodyTooLarge extends Schema.TaggedError<RequestBodyTooLarge>()(
  "Http.RequestBodyTooLarge",
  { limit: Schema.Int },
) {}

interface BodyChunks {
  readonly chunks: Array<Uint8Array>;
  byteLength: number;
}

export const schemaBodyJsonLimited = Effect.fn("Http.schemaBodyJsonLimited")(function* <A, RD>(
  request: HttpServerRequest.HttpServerRequest,
  schema: Schema.ConstraintDecoder<A, RD>,
  limit: number,
) {
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit)
    return yield* new RequestBodyTooLarge({ limit });

  const body = yield* request.stream.pipe(
    Stream.runFoldEffect(
      (): BodyChunks => ({ chunks: [], byteLength: 0 }),
      (state, chunk) => {
        const byteLength = state.byteLength + chunk.byteLength;
        if (byteLength > limit) return Effect.fail(new RequestBodyTooLarge({ limit }));
        state.chunks.push(chunk);
        state.byteLength = byteLength;
        return Effect.succeed(state);
      },
    ),
  );
  const bytes = new Uint8Array(body.byteLength);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    new TextDecoder().decode(bytes),
    { onExcessProperty: "error" },
  );
});
