import { Effect, Result, Schema, SchemaIssue, type SchemaAST } from "effect";
import {
  registrySkitSlugSchema,
  safePathSchema,
  skitDescriptorWireSchema,
  skitValidationDiagnosticSchema,
  type SkitWireDescriptor,
} from "../schemas.js";

/** Capability-neutral primitives shared by consumer and optional write protocols. */
export const SKIT_API_CONTRACT_VERSION = "1" as const;
export function isSafePath(value: unknown): value is string {
  return Schema.is(safePathSchema)(value);
}
export const skitVisibilitySchema = Schema.Literals(["public", "unlisted", "private"]);
export const skitSourceKindSchema = Schema.Literals([
  "registry",
  "git",
  "local",
  "migration",
  "import",
]);

// Effect v4's built-in Base64 regex backtracks badly on multi-megabyte archives. Validate the
// alphabet and padding in linear passes because release publication decodes this wire field.
export const apiBase64Schema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (value.length % 4 !== 0) return false;
      const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
      const content = padding === 0 ? value : value.slice(0, -padding);
      if (!/^[0-9A-Za-z+/]*$/.test(content)) return false;
      return padding === 0 ? content.length % 4 === 0 : content.length % 4 === 4 - padding;
    },
    { expected: "a base64 encoded string" },
  ),
);
export const apiNonEmptyString = Schema.NonEmptyString;
export const apiSkitSlugSchema = registrySkitSlugSchema;
export const apiSemverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const semver = Schema.String.check(Schema.isPattern(apiSemverPattern));

export function parseWireDescriptor(value: unknown): SkitWireDescriptor | null {
  const result = Schema.decodeUnknownResult(skitDescriptorWireSchema, {
    onExcessProperty: "preserve",
  })(value);
  return Result.isSuccess(result) ? { ...result.success } : null;
}
export type { SkitWireDescriptor };
export const skitValidationDiagnosticsSchema = Schema.Array(skitValidationDiagnosticSchema);
export const skitDescriptorRequestSchema = skitDescriptorWireSchema.annotate({
  parseOptions: { onExcessProperty: "preserve" },
});
export const skitApiErrorSchema = Schema.Struct({
  error: apiNonEmptyString,
  request_id: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Unknown),
});
export type SkitApiError = typeof skitApiErrorSchema.Type;

export class SkitContractError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(
    readonly contract: string,
    issues: Array<{ path: string; message: string }>,
  ) {
    super(
      `${contract} does not match the SKIT API contract: ${issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ")}`,
    );
    this.name = "SkitContractError";
    this.issues = issues;
  }
}
const formatContractIssues = SchemaIssue.makeFormatterStandardSchemaV1();
function contractIssues(error: Schema.SchemaError): Array<{ path: string; message: string }> {
  return formatContractIssues(error.issue).issues.map((issue) => ({
    path: issue.path?.map(String).join(".") ?? "",
    message: issue.message,
  }));
}
export function parseContract<S extends Schema.ConstraintDecoder<unknown>>(
  contract: string,
  schema: S,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): S["Type"] {
  const parsed = Schema.decodeUnknownResult(schema, { errors: "all", ...options })(value);
  if (Result.isSuccess(parsed)) return parsed.success;
  throw new SkitContractError(contract, contractIssues(parsed.failure));
}
export function parseContractEffect<S extends Schema.ConstraintDecoder<unknown>>(
  contract: string,
  schema: S,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): Effect.Effect<S["Type"], SkitContractError> {
  return Schema.decodeUnknownEffect(schema, { errors: "all", ...options })(value).pipe(
    Effect.mapError((failure) => new SkitContractError(contract, contractIssues(failure))),
  );
}
