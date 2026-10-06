import { Option, Schema } from "effect";
import catalog from "./model-context-windows.json" with { type: "json" };

export const ModelContextCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  observedAt: Schema.NonEmptyString,
  sources: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      kind: Schema.Literal("model-catalog"),
      observedAt: Schema.NonEmptyString,
      clientVersion: Schema.optionalKey(Schema.NonEmptyString),
      url: Schema.optionalKey(Schema.NonEmptyString),
      aliasReference: Schema.optionalKey(Schema.NonEmptyString),
    }),
  ),
  models: Schema.Array(
    Schema.Struct({
      provider: Schema.NonEmptyString,
      id: Schema.NonEmptyString,
      aliases: Schema.Array(Schema.NonEmptyString),
      contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(
    (value) =>
      new Set(value.models.map((model) => `${model.provider}:${model.id}`)).size ===
        value.models.length || "Model IDs must be unique",
  ),
);
export type ModelContextCatalog = typeof ModelContextCatalog.Type;

/** Versioned, bundled model facts; independent of native harness installations and caches. */
export const modelContextCatalog: ModelContextCatalog =
  Schema.decodeUnknownSync(ModelContextCatalog)(catalog);

export function modelContextWindow(provider: string, model: string | null): Option.Option<number> {
  return Option.fromUndefinedOr(
    modelContextCatalog.models.find(
      (entry) =>
        entry.provider === provider && (entry.id === model || entry.aliases.includes(model ?? "")),
    )?.contextWindow,
  );
}
