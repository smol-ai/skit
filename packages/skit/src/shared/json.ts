/**
 * Boundary types for data whose shape is genuinely arbitrary until it is narrowed.
 *
 * `JsonObject` is for payloads that must stay JSON-serializable — parsed configuration files and
 * the structured report envelopes the CLI emits. `YamlMapping` is for parsed YAML frontmatter,
 * whose values are unconstrained because authors may write anything.
 *
 * Reach for these only at the point where untrusted data enters. Everything past that boundary
 * should hold a declared shape, narrowed through the accessors below.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface YamlMapping {
  [key: string]: unknown;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads `key` as a JSON object, or null when absent or another type. */
export function objectAt(source: JsonObject | undefined, key: string): JsonObject | null {
  const value = source?.[key];
  return isJsonObject(value) ? value : null;
}

/** Reads `key` as a string, or null when absent or another type. */
export function stringAt(source: JsonObject | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

/** Reads `key` as a boolean, or null when absent or another type. */
export function booleanAt(source: JsonObject | undefined, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

/** Reads `key` as an array, or an empty array when absent or another type. */
export function arrayAt(source: JsonObject | undefined, key: string): JsonValue[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

/** Entries of `key` read as a mapping of JSON objects, skipping values of any other type. */
export function objectEntriesAt(
  source: JsonObject | undefined,
  key: string,
): Array<[string, JsonObject]> {
  const value = source?.[key];
  if (!isJsonObject(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, JsonObject] =>
    isJsonObject(entry[1]),
  );
}
