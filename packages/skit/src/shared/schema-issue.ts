import { Schema, SchemaGetter, type SchemaAST, SchemaIssue } from "effect";

/** Schema engine facts that can cross a JSON boundary without callbacks or formatted prose. */
export const ExpectedSchemaType = Schema.Literals([
  "Declaration",
  "Null",
  "Undefined",
  "Void",
  "Never",
  "Unknown",
  "Any",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Literal",
  "UniqueSymbol",
  "ObjectKeyword",
  "Enum",
  "TemplateLiteral",
  "Arrays",
  "Objects",
  "Union",
  "Suspend",
]);
export type ExpectedSchemaType = typeof ExpectedSchemaType.Type;
const Expected = Schema.Struct({
  type: ExpectedSchemaType,
  values: Schema.optionalKey(Schema.Array(Schema.Json)),
});
const Check = Schema.Struct({ id: Schema.String, payload: Schema.Json });
export const SchemaIssueReason = Schema.TaggedUnion({
  MissingKey: {},
  UnexpectedKey: {},
  InvalidType: { expected: Schema.Array(Expected) },
  InvalidValue: { check: Schema.optionalKey(Check) },
  Forbidden: {},
  OneOf: { matches: Schema.Int },
});
export type SchemaIssueReason = typeof SchemaIssueReason.Type;
export const SchemaIssueFact = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
  reason: SchemaIssueReason,
}).annotate({ identifier: "SchemaIssueFact" });
export type SchemaIssueFact = typeof SchemaIssueFact.Type;

const expected = (ast: SchemaAST.AST): (typeof Expected.Type)[] => {
  if (ast._tag === "Union") return ast.types.flatMap(expected);
  if (ast._tag === "Literal")
    return [
      {
        type: typeof ast.literal === "bigint" ? "BigInt" : "Literal",
        values: [typeof ast.literal === "bigint" ? String(ast.literal) : ast.literal],
      },
    ];
  if (ast._tag === "Enum") return [{ type: "Enum", values: ast.enums.map((entry) => entry[1]) }];
  return [{ type: ast._tag }];
};

/** JSON boundary projection: preserve paths, expected types and structured checks for stored diagnostics. */
const schemaIssueFacts = (
  issue: SchemaIssue.Issue,
  path: readonly (string | number)[] = [],
  check?: typeof Check.Type,
): SchemaIssueFact[] => {
  const fact = (reason: SchemaIssueReason): SchemaIssueFact[] => [{ path, reason }];
  switch (issue._tag) {
    case "Pointer":
      return schemaIssueFacts(
        issue.issue,
        [...path, ...issue.path.map((key) => (typeof key === "symbol" ? String(key) : key))],
        check,
      );
    case "Encoding":
      return schemaIssueFacts(issue.issue, path, check);
    case "Filter": {
      const representation = issue.filter.annotations?.representation;
      return schemaIssueFacts(
        issue.issue,
        path,
        representation === undefined
          ? { id: issue.filter.annotations?.identifier ?? "opaque", payload: null }
          : { id: representation.id, payload: representation.payload },
      );
    }
    case "Composite":
      return issue.issues.flatMap((child) => schemaIssueFacts(child, path, check));
    case "AnyOf":
      return issue.issues.length
        ? issue.issues.flatMap((child) => schemaIssueFacts(child, path, check))
        : fact({ _tag: "InvalidType", expected: expected(issue.ast) });
    case "InvalidType":
      return fact({ _tag: "InvalidType", expected: expected(issue.ast) });
    case "InvalidValue":
      return fact({ _tag: "InvalidValue", ...(check === undefined ? {} : { check }) });
    case "MissingKey":
      return fact({ _tag: "MissingKey" });
    case "UnexpectedKey":
      return fact({ _tag: "UnexpectedKey" });
    case "Forbidden":
      return fact({ _tag: "Forbidden" });
    case "OneOf":
      return fact({ _tag: "OneOf", matches: issue.successes.length });
  }
};

/** Native errors stay intact on live paths. Only JSON encoding projects paths, expected
 * types/literals and check ids/payloads. Stored diagnostics do not reconstruct native ASTs,
 * union grouping or executable annotations; the frontend explicitly handles the stored variant. */
const StoredSchemaFailure = Schema.TaggedStruct("StoredSchemaFailure", {
  issues: Schema.Array(SchemaIssueFact),
});
export type SchemaFailure =
  | Schema.SchemaError
  | SchemaIssue.Issue
  | typeof StoredSchemaFailure.Type;
export const SchemaFailure = Schema.Struct({ issues: Schema.Array(SchemaIssueFact) })
  .pipe(
    Schema.decodeTo(
      Schema.Union([
        Schema.declare(Schema.isSchemaError),
        Schema.declare(SchemaIssue.isIssue),
        StoredSchemaFailure,
      ]),
      {
        decode: SchemaGetter.transform(({ issues }) => ({
          _tag: "StoredSchemaFailure" as const,
          issues,
        })),
        encode: SchemaGetter.transform((failure: SchemaFailure) => ({
          issues: Schema.isSchemaError(failure)
            ? schemaIssueFacts(failure.issue)
            : SchemaIssue.isIssue(failure)
              ? schemaIssueFacts(failure)
              : failure.issues,
        })),
      },
    ),
  )
  .annotate({ identifier: "SchemaFailure" });
