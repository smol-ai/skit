import { Schema } from "effect";
export const SkitValidationDiagnostic = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["info", "warning", "error"]),
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
});
export type SkitValidationDiagnostic = typeof SkitValidationDiagnostic.Type;
