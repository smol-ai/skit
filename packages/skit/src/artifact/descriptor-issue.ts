import { Schema } from "effect";
import type { YAMLError } from "yaml";
import { SchemaFailure } from "../shared/schema-issue.js";

export const YamlErrorCode = Schema.Literals([
  "ALIAS_PROPS",
  "BAD_ALIAS",
  "BAD_DIRECTIVE",
  "BAD_DQ_ESCAPE",
  "BAD_INDENT",
  "BAD_PROP_ORDER",
  "BAD_SCALAR_START",
  "BLOCK_AS_IMPLICIT_KEY",
  "BLOCK_IN_FLOW",
  "DUPLICATE_KEY",
  "IMPOSSIBLE",
  "KEY_OVER_1024_CHARS",
  "MISSING_CHAR",
  "MULTILINE_IMPLICIT_KEY",
  "MULTIPLE_ANCHORS",
  "MULTIPLE_DOCS",
  "MULTIPLE_TAGS",
  "NON_STRING_KEY",
  "RESOURCE_EXHAUSTION",
  "TAB_AS_INDENT",
  "TAG_RESOLVE_FAILED",
  "UNEXPECTED_TOKEN",
  "BAD_COLLECTION_TYPE",
]);
export type YamlErrorCode = typeof YamlErrorCode.Type;
const YamlIssueFact = Schema.Struct({
  code: YamlErrorCode,
  start: Schema.Int,
  end: Schema.Int,
  line: Schema.optionalKey(Schema.Int),
  column: Schema.optionalKey(Schema.Int),
});
export const YamlWarning = Schema.TaggedStruct("YamlWarning", YamlIssueFact.fields);
export type YamlWarning = typeof YamlWarning.Type;
export const yamlIssueFact = (error: YAMLError): typeof YamlIssueFact.Type => ({
  code: error.code,
  start: error.pos[0],
  end: error.pos[1],
  ...(error.linePos === undefined
    ? {}
    : { line: error.linePos[0].line, column: error.linePos[0].col }),
});

export const DescriptorIssue = Schema.TaggedUnion({
  JsonSyntax: {
    offset: Schema.optionalKey(Schema.Int),
    line: Schema.optionalKey(Schema.Int),
    column: Schema.optionalKey(Schema.Int),
  },
  YamlSyntax: { errors: Schema.Array(YamlIssueFact) },
  YamlValue: {},
  Schema: { failure: SchemaFailure },
}).annotate({ identifier: "DescriptorIssue" });
export type DescriptorIssue = typeof DescriptorIssue.Type;
