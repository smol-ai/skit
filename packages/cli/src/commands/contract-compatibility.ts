export interface ContractCompatibilityInput {
  readonly baseArtifacts: Readonly<Record<string, string>>;
  readonly headArtifacts: Readonly<Record<string, string>>;
  readonly baseManifest: string;
}

export interface ContractCompatibilityResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface CommandManifest {
  readonly commands: readonly {
    readonly stability: "stable" | "experimental";
    readonly outputSchemas: readonly string[];
  }[];
}

/**
 * Removing a stable command is a breaking change; name each retired contract here on purpose.
 * An entry can go once the published release used for comparison no longer has the contract.
 */
const retiredContractIds: ReadonlySet<string> = new Set([
  // `skit pin` only selected Versions of pre-release Registry Sources.
  "skit.pin.v5",
  "skit.pin.plan.v5",
  // `skit pull` duplicated `skit update <subject>`.
  "skit.pull.v6",
]);

const contractId = (contents: string): string | undefined => {
  const parsed: unknown = JSON.parse(contents);
  if (typeof parsed !== "object" || parsed === null || !("$id" in parsed)) return undefined;
  return typeof parsed.$id === "string" ? parsed.$id : undefined;
};

const versionedFamily = (
  id: string,
): { readonly family: string; readonly version: number } | undefined => {
  const match = id.match(/^(.*)\.v([1-9][0-9]*)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { family: match[1], version: Number(match[2]) };
};

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const isObject = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lower bounds keep the larger value and upper bounds the smaller, so merging only tightens. */
const lowerBounds = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const upperBounds = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);

/**
 * The same schema however a generator nests it. Effect upgrades can write a bound as
 * `{ minimum: -MAX, allOf: [{ minimum: 0 }] }` or as `{ minimum: 0 }`, and a union of unions
 * either nested or flat; neither changes which documents validate. Only rewrites that keep the
 * accepted documents identical belong here: anything else is a real shape change.
 */
const normalizeSchema = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!isObject(value)) return value;
  const schema: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) schema[key] = normalizeSchema(value[key]!);
  if (Array.isArray(schema.allOf)) {
    const remaining: Json[] = [];
    for (const member of schema.allOf) {
      const bounds =
        isObject(member) &&
        Object.entries(member).every(
          ([key, bound]) =>
            (lowerBounds.has(key) || upperBounds.has(key)) && typeof bound === "number",
        );
      if (!bounds || !isObject(member)) {
        remaining.push(member);
        continue;
      }
      for (const [key, bound] of Object.entries(member) as [string, number][]) {
        const current = schema[key];
        schema[key] =
          typeof current !== "number"
            ? bound
            : lowerBounds.has(key)
              ? Math.max(current, bound)
              : Math.min(current, bound);
      }
    }
    if (remaining.length === 0) delete schema.allOf;
    else schema.allOf = remaining;
  }
  if (Array.isArray(schema.anyOf))
    schema.anyOf = schema.anyOf.flatMap((member) =>
      isObject(member) && Object.keys(member).length === 1 && Array.isArray(member.anyOf)
        ? member.anyOf
        : [member],
    );
  return Object.fromEntries(
    Object.keys(schema)
      .sort()
      .map((key) => [key, schema[key]!]),
  );
};

const sameShape = (left: string, right: string) =>
  left === right ||
  JSON.stringify(normalizeSchema(JSON.parse(left))) ===
    JSON.stringify(normalizeSchema(JSON.parse(right)));

const artifactsById = (artifacts: Readonly<Record<string, string>>) =>
  new Map(
    Object.values(artifacts).flatMap((contents) => {
      const id = contractId(contents);
      return id === undefined ? [] : [[id, contents] as const];
    }),
  );

export function checkContractCompatibility(
  input: ContractCompatibilityInput,
): ContractCompatibilityResult {
  const manifest: CommandManifest = JSON.parse(input.baseManifest);
  const stableIds = new Set(
    manifest.commands
      .filter((command) => command.stability === "stable")
      .flatMap((command) => command.outputSchemas),
  );
  const experimentalIds = new Set(
    manifest.commands
      .filter((command) => command.stability === "experimental")
      .flatMap((command) => command.outputSchemas),
  );
  const base = artifactsById(input.baseArtifacts);
  const head = artifactsById(input.headArtifacts);
  const errors: string[] = [];
  const warnings: string[] = [];

  const headVersions = new Map<string, Set<number>>();
  for (const id of head.keys()) {
    const versioned = versionedFamily(id);
    if (versioned === undefined) continue;
    const versions = headVersions.get(versioned.family) ?? new Set<number>();
    versions.add(versioned.version);
    headVersions.set(versioned.family, versions);
  }

  for (const [id, baseContents] of base) {
    const headContents = head.get(id);
    const stable = stableIds.has(id);
    const experimental = experimentalIds.has(id) && !stable;
    if (headContents !== undefined) {
      if (!sameShape(baseContents, headContents)) {
        const message = `${id} changed shape without changing its contract ID`;
        if (stable) errors.push(message);
        else if (experimental) warnings.push(message);
      }
      continue;
    }

    if (stable && retiredContractIds.has(id)) {
      warnings.push(`${id} was removed`);
      continue;
    }
    const versioned = versionedFamily(id);
    const replaced =
      versioned !== undefined &&
      (headVersions.get(versioned.family)?.has(versioned.version + 1) ?? false);
    const message =
      replaced && versioned !== undefined
        ? `${id} was replaced by ${versioned.family}.v${versioned.version + 1}`
        : `${id} was removed without a one-version successor`;
    if (stable && !replaced) errors.push(message);
    else if (experimental) warnings.push(message);
  }

  const baseFamilyMaximum = new Map<string, number>();
  for (const id of base.keys()) {
    if (!stableIds.has(id)) continue;
    const versioned = versionedFamily(id);
    if (versioned === undefined) continue;
    baseFamilyMaximum.set(
      versioned.family,
      Math.max(baseFamilyMaximum.get(versioned.family) ?? 0, versioned.version),
    );
  }
  for (const [family, baseMaximum] of baseFamilyMaximum) {
    const versions = headVersions.get(family);
    if (versions === undefined) continue;
    const headMaximum = Math.max(...versions);
    if (headMaximum > baseMaximum + 1)
      errors.push(
        `${family} jumped from v${baseMaximum} to v${headMaximum}; use v${baseMaximum + 1}`,
      );
  }

  return { errors, warnings };
}
