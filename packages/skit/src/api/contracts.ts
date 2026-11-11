import { SchemaFailure } from "../shared/schema-issue.js";
import { TreePathIssue } from "../history/history.js";
import { Effect, Result, Schema, type SchemaAST } from "effect";
import {
  registrySkitSlugSchema,
  skitDescriptorWireSchema,
  skitValidationDiagnosticSchema,
  type SkitWireDescriptor,
} from "../artifact/schemas.js";
import { FailureTypeId, type SkitFailure } from "../shared/failure.js";
export const skitVisibilitySchema = Schema.Literals(["public", "unlisted", "private"]);

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
    { representation: { id: "skit/schema/base64", payload: null } },
  ),
);
export const apiNonEmptyString = Schema.NonEmptyString;
export const apiSkitSlugSchema = registrySkitSlugSchema;
export const apiSemverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
export const semver = Schema.String.check(Schema.isPattern(apiSemverPattern));

export function parseWireDescriptor(value: unknown): SkitWireDescriptor | null {
  const result = Schema.decodeUnknownResult(skitDescriptorWireSchema)(value);
  return Result.isSuccess(result) ? { ...result.success } : null;
}
export const skitValidationDiagnosticsSchema = Schema.Array(skitValidationDiagnosticSchema);
export const skitDescriptorRequestSchema = skitDescriptorWireSchema;

/** A Registry response that does not match the SKIT API contract it claims. */
const SkitContractErrorReason = Schema.TaggedUnion({
  InvalidData: { failure: SchemaFailure },
  InvalidTree: { issue: TreePathIssue },
  InvalidWriteTarget: { path: Schema.String },
  UnsupportedTreeEntry: { path: Schema.String, kind: Schema.Literals(["directory", "symlink"]) },
  ReadFailed: { failure: Schema.Defect() },
});
type SkitContractErrorReason = typeof SkitContractErrorReason.Type;

export class SkitContractError
  extends Schema.TaggedError<SkitContractError, { readonly brand: unique symbol }>()(
    "SkitContractError",
    { contract: Schema.String, reason: SkitContractErrorReason },
  )
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
}
export function parseContract<S extends Schema.ConstraintDecoder<unknown>>(
  contract: string,
  schema: S,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): Effect.Effect<S["Type"], SkitContractError> {
  return Schema.decodeUnknownEffect(schema, { errors: "all", ...options })(value).pipe(
    Effect.mapError(
      (failure) => new SkitContractError({ contract, reason: { _tag: "InvalidData", failure } }),
    ),
  );
}
