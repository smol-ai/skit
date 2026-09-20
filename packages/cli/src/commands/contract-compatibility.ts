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
      if (headContents !== baseContents) {
        const message = `${id} changed shape without changing its contract ID`;
        if (stable) errors.push(message);
        else if (experimental) warnings.push(message);
      }
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
