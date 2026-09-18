import { parse as parseYaml } from "yaml";
import { Schema } from "effect";
import { HarnessName } from "../library/store/state-schema.js";
import type { YamlMapping } from "../shared/json.js";
import type {
  FrontmatterConstraint,
  FrontmatterValueType,
  HarnessFrontmatterContract,
  HarnessFrontmatterField,
} from "./contracts.js";
import { harnessProfile } from "./catalog.js";

export const FrontmatterCompatibilityIssue = Schema.Struct({
  code: Schema.Literals([
    "frontmatter-missing",
    "frontmatter-invalid",
    "field-missing",
    "field-type",
    "field-constraint",
    "field-unknown",
  ]),
  field: Schema.NullOr(Schema.String),
  severity: Schema.Literals(["error", "unknown"]),
  sourceIds: Schema.Array(Schema.String),
});
export type FrontmatterCompatibilityIssue = typeof FrontmatterCompatibilityIssue.Type;

export const FrontmatterCompatibilityResult = Schema.Struct({
  harness: HarnessName,
  contractId: Schema.String,
  variant: Schema.String,
  status: Schema.Literals(["valid", "invalid", "unknown"]),
  fields: Schema.Record(Schema.String, Schema.Unknown),
  issues: Schema.mutableKey(Schema.mutable(Schema.Array(FrontmatterCompatibilityIssue))),
});
export type FrontmatterCompatibilityResult = typeof FrontmatterCompatibilityResult.Type;

function valueMatches(value: unknown, type: FrontmatterValueType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "boolean-like")
    return (
      typeof value === "boolean" ||
      (typeof value === "string" && /^(?:true|false|yes|no|on|off|1|0)$/i.test(value))
    );
  if (type === "string-list")
    return (
      typeof value === "string" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    );
  if (type === "object")
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as YamlMapping).every((item) => typeof item === "string")
  );
}

function constraintMatches(
  value: unknown,
  constraint: FrontmatterConstraint,
  directoryName?: string,
): boolean {
  if (constraint.kind === "directory-name")
    return directoryName === undefined || value === directoryName;
  if (constraint.kind === "enum")
    return typeof value === "string" && constraint.values.includes(value);
  if (typeof value !== "string") return false;
  if (constraint.kind === "pattern") return new RegExp(constraint.value).test(value);
  return (
    (constraint.min === undefined || value.length >= constraint.min) &&
    (constraint.max === undefined || value.length <= constraint.max)
  );
}

export function frontmatterContract(
  harness: HarnessName,
  variant?: string,
): HarnessFrontmatterContract {
  const contracts = harnessProfile(harness).frontmatter;
  const contract = variant
    ? contracts.find((candidate) => candidate.variant === variant)
    : contracts.find((candidate) => candidate.default);
  if (!contract)
    throw new Error(`Unknown frontmatter contract for ${harness}${variant ? `: ${variant}` : ""}`);
  return contract;
}

export function parseSkillFrontmatter(text: string): YamlMapping | null {
  const match = text.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
  if (!match) return null;
  if (!match[1] || match[1].trim() === "") return {};
  try {
    const value = parseYaml(match[1]);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as YamlMapping)
      : null;
  } catch {
    return null;
  }
}

export function evaluateSkillFrontmatter(
  text: string,
  harness: HarnessName,
  options: { variant?: string; directoryName?: string } = {},
): FrontmatterCompatibilityResult {
  const contract = frontmatterContract(harness, options.variant);
  const parsedFields = parseSkillFrontmatter(text);
  const fields = parsedFields ?? {};
  const issues: FrontmatterCompatibilityIssue[] = [];
  if (!parsedFields) {
    if (/^---\r?\n/.test(text))
      issues.push({
        code: "frontmatter-invalid",
        field: null,
        severity: "error",
        sourceIds: contract.sourceIds,
      });
    else if (contract.frontmatter === "required")
      issues.push({
        code: "frontmatter-missing",
        field: null,
        severity: "error",
        sourceIds: contract.sourceIds,
      });
  }
  const definitions = new Map(contract.fields.map((field) => [field.name, field]));
  for (const definition of contract.fields)
    evaluateField(definition, fields, issues, options.directoryName);
  if (contract.unknownFields === "unknown")
    for (const field of Object.keys(fields))
      if (!definitions.has(field))
        issues.push({
          code: "field-unknown",
          field,
          severity: "unknown",
          sourceIds: contract.sourceIds,
        });
  return {
    harness: harness,
    contractId: contract.id,
    variant: contract.variant,
    status: issues.some((issue) => issue.severity === "error")
      ? "invalid"
      : issues.length
        ? "unknown"
        : "valid",
    fields,
    issues,
  };
}

function evaluateField(
  definition: HarnessFrontmatterField,
  fields: YamlMapping,
  issues: FrontmatterCompatibilityIssue[],
  directoryName?: string,
): void {
  const value = fields[definition.name];
  if (value === undefined) {
    if (definition.support === "required")
      issues.push({
        code: "field-missing",
        field: definition.name,
        severity: "error",
        sourceIds: definition.sourceIds,
      });
    return;
  }
  if (definition.support === "ignored") return;
  if (!valueMatches(value, definition.type)) {
    if (definition.invalidValue !== "ignored")
      issues.push({
        code: "field-type",
        field: definition.name,
        severity: definition.invalidValue === "unknown" ? "unknown" : "error",
        sourceIds: definition.sourceIds,
      });
    return;
  }
  if (
    definition.constraints?.some(
      (constraint) => !constraintMatches(value, constraint, directoryName),
    )
  )
    issues.push({
      code: "field-constraint",
      field: definition.name,
      severity: "error",
      sourceIds: definition.sourceIds,
    });
}
