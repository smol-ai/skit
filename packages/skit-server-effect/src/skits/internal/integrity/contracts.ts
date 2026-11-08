import { Hash, safePathSchema } from "@smolai/skit-core/universal/consumer";
import { IntegrityErrorCode } from "@smolai/skit-core/api";
import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const ArtifactFile = Schema.Struct({
  path: safePathSchema,
  bytes: Schema.Uint8Array,
  digest: Hash,
  executable: Schema.Boolean,
});
export interface ArtifactFile extends Schema.Schema.Type<typeof ArtifactFile> {}

export const ValidationDiagnostic = Schema.Struct({
  code: NonEmptyString,
  severity: Schema.Literal("error"),
  path: safePathSchema,
  message: NonEmptyString,
});
export interface ValidationDiagnostic extends Schema.Schema.Type<typeof ValidationDiagnostic> {}

export class IntegrityError extends Schema.TaggedError<
  IntegrityError,
  { readonly brand: unique symbol }
>()("Integrity.Error", {
  code: IntegrityErrorCode,
  detail: Schema.optionalKey(Schema.String),
}) {}
