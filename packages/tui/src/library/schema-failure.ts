import { LocalStateViolation } from "@smolai/skit-core/library/local-state-violation";
import { localStateViolation } from "./local-state-violation";
import { ManifestViolation } from "@smolai/skit-core/library/manifest-violation";
import { manifestViolation } from "./manifest-violation";
import {
  SchemaIssueReason,
  type SchemaIssueFact,
  type SchemaFailure,
  type ExpectedSchemaType,
} from "@smolai/skit-core/shared";
import { Predicate, Schema, SchemaIssue } from "effect";

const names = {
  Declaration: "declared type",
  Null: "null",
  Undefined: "undefined",
  Void: "void",
  Never: "no value",
  Unknown: "any value",
  Any: "any value",
  String: "string",
  Number: "number",
  Boolean: "boolean",
  BigInt: "bigint",
  Symbol: "symbol",
  Literal: "literal",
  UniqueSymbol: "specific symbol",
  ObjectKeyword: "object",
  Enum: "enum value",
  TemplateLiteral: "matching string",
  Arrays: "array",
  Objects: "object",
  Union: "allowed value",
  Suspend: "declared type",
} satisfies Record<ExpectedSchemaType, string>;

const checkFailure = (check: { readonly id: string; readonly payload: unknown }): string => {
  const value = (key: string) =>
    Predicate.hasProperty(check.payload, key) ? String(check.payload[key]) : "";
  switch (check.id) {
    case "skit/schema/library-local-state":
      return Schema.is(LocalStateViolation)(check.payload)
        ? localStateViolation(check.payload)
        : "Local Library failed relational validation";
    case "skit/schema/library-manifest":
      return Schema.is(ManifestViolation)(check.payload)
        ? manifestViolation(check.payload)
        : "Library manifest failed relational validation";
    case "skit/schema/base64":
      return "Value must be a base64 encoded string";
    case "skit/schema/model-context-bounds":
      return "Default context window must not exceed the maximum";
    case "skit/schema/model-identifiers-unique":
      return "Model IDs must be unique within each provider";
    case "skit/schema/revision-error-code":
      return "Revision error code must not use a dedicated HTTP response code";
    case "skit/schema/path-absolute":
      return "Path must be absolute";
    case "skit/schema/typeid":
      return `Expected a canonical ${value("prefix")} TypeID`;
    case "skit/schema/installed-change-status":
      return "Recorded result and installed row status must agree";
    case "skit/schema/url":
      return "Value must be a valid URL";
    case "skit/schema/source-relative-path":
    case "skit/schema/path-relative":
      return "Path must be safe and relative";
    case "skit/schema/path-portable":
      return "Path must not contain backslashes or NUL bytes";
    case "skit/schema/path-nfc":
      return "Path must use NFC normalization";
    case "skit/schema/registry-slug":
      return "SKIT slug must be canonical";
    case "skit/schema/registry-id":
      return "Registry SKIT id must contain a canonical Namespace and SKIT slug";
    case "skit/schema/skills-sh-original-limit":
      return `skills.sh original entry must not exceed ${value("maxBytes")} bytes`;
    case "effect/schema/isBetween":
      return `Value must be ${Predicate.hasProperty(check.payload, "exclusiveMinimum") && check.payload.exclusiveMinimum === true ? "greater than" : "at least"} ${value("minimum")} and ${Predicate.hasProperty(check.payload, "exclusiveMaximum") && check.payload.exclusiveMaximum === true ? "less than" : "at most"} ${value("maximum")}`;
    case "effect/schema/isPattern":
      return `Value must match ${value("source")}${value("flags") ? ` (${value("flags")})` : ""}`;
    case "effect/schema/isMinLength":
      return `Length must be at least ${value("minLength")}`;
    case "effect/schema/isMaxLength":
      return `Length must be at most ${value("maxLength")}`;
    default:
      return "Value does not satisfy its required format";
  }
};

const schemaIssue = ({ path, reason }: SchemaIssueFact): string => {
  const message = SchemaIssueReason.match(reason, {
    MissingKey: () => "Missing required field",
    UnexpectedKey: () => "Unexpected field",
    InvalidType: ({ expected }) =>
      `Expected ${expected
        .map((item) =>
          item.values?.length
            ? item.values
                .map((value) => (item.type === "BigInt" ? `${value}n` : JSON.stringify(value)))
                .join(" | ")
            : names[item.type],
        )
        .join(" | ")}`,
    InvalidValue: ({ check }) => (check === undefined ? "Invalid value" : checkFailure(check)),
    Forbidden: () => "Value is forbidden here",
    OneOf: ({ matches }) => `Expected exactly one matching type; found ${matches}`,
  });
  return path.length
    ? `${message} at ${path.map((key) => `[${JSON.stringify(key)}]`).join("")}`
    : message;
};

const nativeSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: (issue) => {
    const representation = issue.filter.annotations?.representation;
    return representation !== undefined &&
      (representation.id.startsWith("skit/schema/") ||
        representation.id === "effect/schema/isBetween")
      ? checkFailure(representation)
      : SchemaIssue.defaultCheckHook(issue);
  },
});
export const schemaFailure = (failure: SchemaFailure): string =>
  Schema.isSchemaError(failure) || SchemaIssue.isIssue(failure)
    ? nativeSchemaIssue(Schema.isSchemaError(failure) ? failure.issue : failure)
        .issues.map(
          (issue) =>
            `${issue.message}${issue.path?.length ? ` at ${issue.path.map((key) => `[${typeof key === "string" ? JSON.stringify(key) : String(key)}]`).join("")}` : ""}`,
        )
        .join("\n")
    : failure.issues.map(schemaIssue).join("\n");
