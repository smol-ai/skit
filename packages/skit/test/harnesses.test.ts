import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, expectTypeOf, test } from "vitest";
import { defaultSkillsRoot } from "../src/harnesses/default-roots.js";
import { evaluateSkillFrontmatter } from "../src/harnesses/frontmatter.js";
import {
  harnessProfile,
  harnessProfiles,
  installSkillsDirectory,
  resolveSkillsDirectory,
} from "../src/harnesses/catalog.js";
import {
  type HarnessDocumentationSource,
  type HarnessName,
  type HarnessProfile,
  type SkillsDirectory,
  type SkillsDirectoryContext,
} from "../src/harnesses/contracts.js";

function assertVerifiedDate(value: string, label: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error(`Invalid verified date for ${label}: ${value}`);
}

function assertHarnessCatalog(profiles: Readonly<Record<string, HarnessProfile>>): void {
  const profileIds = new Set<string>();
  for (const profile of Object.values(profiles)) {
    if (profileIds.has(profile.profile.id))
      throw new Error(`Duplicate profile id: ${profile.profile.id}`);
    profileIds.add(profile.profile.id);
    JSON.stringify(profile);
    const sourceIds = new Set<string>(profile.documentation.map((source) => source.id));
    if (sourceIds.size !== profile.documentation.length)
      throw new Error(`Duplicate documentation source for ${profile.id}`);
    assertVerifiedDate(profile.profile.verifiedAt, profile.profile.id);
    for (const source of profile.documentation as readonly HarnessDocumentationSource[]) {
      assertVerifiedDate(source.verifiedAt, source.id);
      if (source.kind !== "observed") {
        if (!source.url) throw new Error(`Documented source requires a URL: ${source.id}`);
        try {
          new URL(source.url);
        } catch {
          throw new Error(`Invalid documentation URL for ${source.id}: ${source.url}`);
        }
      }
    }
    const contractIds = new Set<string>();
    for (const contract of [
      profile.frontmatter.default,
      ...Object.values(profile.frontmatter.variants),
    ]) {
      if (contractIds.has(contract.id))
        throw new Error(`Duplicate frontmatter contract for ${profile.id}: ${contract.id}`);
      contractIds.add(contract.id);
      const fieldNames = new Set<string>();
      for (const field of contract.fields) {
        if (fieldNames.has(field.name))
          throw new Error(`Duplicate frontmatter field for ${profile.id}: ${field.name}`);
        fieldNames.add(field.name);
        for (const constraint of field.constraints ?? []) {
          if (
            constraint.kind === "length" &&
            constraint.min === undefined &&
            constraint.max === undefined
          )
            throw new Error(`Empty length constraint for ${profile.id}: ${field.name}`);
          if (
            constraint.kind === "length" &&
            constraint.min !== undefined &&
            constraint.max !== undefined &&
            constraint.min > constraint.max
          )
            throw new Error(`Invalid length constraint for ${profile.id}: ${field.name}`);
          if (constraint.kind === "enum" && !constraint.values.length)
            throw new Error(`Empty enum constraint for ${profile.id}: ${field.name}`);
          if (constraint.kind === "pattern") {
            try {
              new RegExp(constraint.value);
            } catch {
              throw new Error(`Invalid pattern constraint for ${profile.id}: ${field.name}`);
            }
          }
        }
      }
      for (const sourceId of [
        ...contract.sourceIds,
        ...contract.fields.flatMap((field) => field.sourceIds),
      ])
        if (!sourceIds.has(sourceId))
          throw new Error(`Unknown source ${sourceId} for ${profile.id}`);
    }
    const metadataContracts = profile.skillMetadata ?? [];
    if (metadataContracts.filter((candidate) => candidate.default).length > 1)
      throw new Error(`Multiple default skill metadata contracts for ${profile.id}`);
    const metadataContractIds = new Set<string>();
    for (const contract of metadataContracts) {
      if (metadataContractIds.has(contract.id))
        throw new Error(`Duplicate skill metadata contract for ${profile.id}: ${contract.id}`);
      metadataContractIds.add(contract.id);
      const fieldPaths = new Set<string>();
      for (const field of contract.fields) {
        if (fieldPaths.has(field.path))
          throw new Error(`Duplicate skill metadata field for ${profile.id}: ${field.path}`);
        fieldPaths.add(field.path);
      }
      for (const sourceId of [
        ...contract.sourceIds,
        ...contract.fields.flatMap((field) => field.sourceIds),
      ])
        if (!sourceIds.has(sourceId))
          throw new Error(`Unknown source ${sourceId} for ${profile.id}`);
    }
    const rootIds = new Set<string>();
    const pathClaims = new Map<string, Pick<SkillsDirectory, "role" | "evidence">>();
    for (const root of Object.values(profile.roots)) {
      if (rootIds.has(root.id)) throw new Error(`Duplicate root id for ${profile.id}: ${root.id}`);
      rootIds.add(root.id);
      const pathKey = `${root.base}:${root.scope}:${root.path}`;
      const claim = pathClaims.get(pathKey);
      if (claim && (claim.role !== root.role || claim.evidence !== root.evidence))
        throw new Error(`Inconsistent root claim for ${profile.id}: ${root.path}`);
      pathClaims.set(pathKey, root);
    }
    for (const [scope, target] of [
      ["global", profile.installedSkill.globalTarget],
      ["project", profile.installedSkill.projectTarget],
    ] as const) {
      const root = target;
      if (!root.writable) throw new Error(`Install destination is not writable: ${target}`);
      if (root.scope !== scope) throw new Error(`Install destination has wrong scope: ${target}`);
    }
  }
}

function harnessCatalogFreshness(
  asOf: Date,
  maxAgeDays = 180,
): { stale: HarnessName[]; maxAgeDays: number } {
  const cutoff = asOf.getTime() - maxAgeDays * 86_400_000;
  return {
    stale: Object.values(harnessProfiles)
      .filter(
        (profile) => new Date(`${profile.profile.verifiedAt}T00:00:00.000Z`).getTime() < cutoff,
      )
      .map((profile) => profile.id),
    maxAgeDays,
  };
}

function harnessDocumentationFreshness(
  asOf: Date,
  maxAgeDays = 180,
): { stale: Array<{ harness: HarnessName; sourceId: string }>; maxAgeDays: number } {
  const cutoff = asOf.getTime() - maxAgeDays * 86_400_000;
  return {
    stale: Object.values(harnessProfiles).flatMap((profile) =>
      profile.documentation
        .filter((source) => new Date(`${source.verifiedAt}T00:00:00.000Z`).getTime() < cutoff)
        .map((source) => ({ harness: profile.id, sourceId: source.id })),
    ),
    maxAgeDays,
  };
}

describe("Harness Profile catalog", () => {
  test("the shipped catalog satisfies its invariants", () => {
    expect(() => assertHarnessCatalog(harnessProfiles)).not.toThrow();
  });

  test("profiles and install destinations are serializable and unique", () => {
    const profiles = Object.values(harnessProfiles);
    expect(new Set(profiles.map((item) => item.profile.id)).size).toBe(profiles.length);
    expect(() => JSON.stringify(profiles)).not.toThrow();
    for (const profile of profiles)
      for (const target of [
        profile.installedSkill.globalTarget,
        profile.installedSkill.projectTarget,
      ])
        expect(target.writable).toBe(true);
  });

  test("preserves the existing Codex compatibility install destination", () => {
    const profile = harnessProfile("codex");
    const target = profile.installedSkill.globalTarget;
    expect(target).toEqual(
      expect.objectContaining({ role: "compatibility", path: ".agents/skills", writable: true }),
    );
    expect(defaultSkillsRoot("codex")).toBe(join(homedir(), ".agents", "skills"));
    expect(Object.values(profile.roots).find((root) => root.id === "codex-global-native")).toEqual(
      expect.objectContaining({ path: ".codex/skills", role: "native" }),
    );
    expect(profile.roots["codex-project-agents"]).toMatchObject({
      role: "compatibility",
      evidence: "observed",
      writable: true,
    });
    expect(profile.roots["codex-project-codex"]).toMatchObject({
      role: "native",
      evidence: "documented",
      writable: false,
    });
  });

  test("preserves the existing OpenCode skills directory when XDG_CONFIG_HOME differs", () => {
    const context = { home: "/users/test", configHome: "/xdg/config" };
    expect(installSkillsDirectory("opencode", { scope: "global", ...context })).toBe(
      resolve("/users/test/.config/opencode/skills"),
    );
    expect(
      resolveSkillsDirectory({
        ...harnessProfile("opencode").roots["opencode-global-native"],
        ...context,
      }),
    ).toBe(resolve("/xdg/config/opencode/skills"));
  });

  test("does not invent a global Claude .agents compatibility root", () => {
    const roots: readonly SkillsDirectory[] = Object.values(harnessProfile("claude-code").roots);
    expect(
      roots.some(
        (root) =>
          root.scope === "project" &&
          root.role === "compatibility" &&
          root.path === ".agents/skills",
      ),
    ).toBe(true);
    expect(
      roots.some(
        (root) =>
          root.scope === "global" &&
          root.role === "compatibility" &&
          root.path === ".agents/skills",
      ),
    ).toBe(false);
  });

  test("uses Devin CLI native roots without colliding with shared compatibility roots", () => {
    const profile = harnessProfile("devin");
    const context = {
      home: "/users/test",
      configHome: "/xdg/config",
      repository: "/work/project",
    };

    expect(installSkillsDirectory("devin", { scope: "global", ...context })).toBe(
      resolve("/xdg/config/devin/skills"),
    );
    expect(
      installSkillsDirectory("devin", { scope: "project", repository: context.repository }),
    ).toBe(resolve("/work/project/.devin/skills"));
    expect(profile.roots["devin-global-cognition"]).toMatchObject({
      path: "cognition/skills",
      readable: true,
      writable: false,
    });
    expect(
      Object.values(profile.roots).find(
        (root) => root.scope === "project" && root.path === ".cognition/skills",
      ),
    ).toMatchObject({ readable: true, writable: false });
    expect(profile.roots["devin-global-agents"]).toMatchObject({
      path: ".agents/skills",
      readable: true,
      writable: false,
    });
  });

  test("surfaces stale profile verification", () => {
    expect(harnessCatalogFreshness(new Date("2026-08-25T00:00:00.000Z")).stale).toEqual([]);
    expect(harnessCatalogFreshness(new Date("2027-08-25T00:00:00.000Z")).stale).toEqual([
      "codex",
      "claude-code",
      "opencode",
      "devin",
    ]);
  });

  test("surfaces stale first-party documentation verification", () => {
    expect(harnessDocumentationFreshness(new Date("2026-08-25T00:00:00.000Z")).stale).toEqual([]);
    expect(
      harnessDocumentationFreshness(new Date("2027-08-25T00:00:00.000Z")).stale.length,
    ).toBeGreaterThan(4);
  });

  test("links every frontmatter claim to registered evidence", () => {
    for (const profile of Object.values<HarnessProfile>(harnessProfiles)) {
      const sources = new Set<string>(profile.documentation.map((source) => source.id));
      for (const contract of [
        profile.frontmatter.default,
        ...Object.values(profile.frontmatter.variants),
      ])
        for (const field of contract.fields)
          expect(field.sourceIds.every((sourceId) => sources.has(sourceId))).toBe(true);
      for (const contract of profile.skillMetadata ?? [])
        for (const field of contract.fields)
          expect(field.sourceIds.every((sourceId) => sources.has(sourceId))).toBe(true);
    }
  });

  test("keeps directory identities unique", () => {
    const profiles = structuredClone(harnessProfiles);
    Reflect.set(
      profiles.codex.roots["codex-global-native"],
      "id",
      profiles.codex.roots["codex-global-shared"].id,
    );
    expect(() => assertHarnessCatalog(profiles)).toThrow("Duplicate root id");
  });

  test("requires real catalog choices and the context each directory needs", () => {
    expectTypeOf<typeof harnessProfiles.codex.roots>().not.toHaveProperty("absent");
    expectTypeOf<typeof harnessProfiles.opencode.frontmatter.variants>().not.toHaveProperty(
      "absent",
    );
    expectTypeOf<[]>().not.toExtend<HarnessProfile["frontmatter"]>();
    expectTypeOf<HarnessProfile["installedSkill"]["projectTarget"]>().not.toExtend<
      HarnessProfile["installedSkill"]["globalTarget"]
    >();
    expectTypeOf<{ scope: "project" }>().not.toExtend<SkillsDirectoryContext>();
    expectTypeOf<Parameters<typeof evaluateSkillFrontmatter>[1]>().toHaveProperty("harness");
    expectTypeOf<Parameters<typeof resolveSkillsDirectory>[0]>()
      .extract<{ scope: "project" }>()
      .toHaveProperty("repository");
  });

  test("evaluates executable field constraints without rendering CLI prose", () => {
    const valid = evaluateSkillFrontmatter(
      "---\nname: code-review\ndescription: Review code.\n---\n",
      harnessProfile("opencode").frontmatter.default,
      { directoryName: "code-review" },
    );
    expect(valid).toMatchObject({ status: "valid", harness: "opencode", issues: [] });

    const invalid = evaluateSkillFrontmatter(
      "---\nname: Wrong--Name\ndescription: ''\n---\n",
      harnessProfile("opencode").frontmatter.default,
      { directoryName: "code-review" },
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.issues.map((issue) => [issue.code, issue.field])).toEqual([
      ["field-constraint", "name"],
      ["field-constraint", "description"],
    ]);
  });

  test("does not turn portability rules into undocumented Codex enforcement", () => {
    expect(
      evaluateSkillFrontmatter(
        "---\nname: My_Skill\ndescription: Review.\n---\n",
        harnessProfile("codex").frontmatter.default,
        {
          directoryName: "different",
        },
      ),
    ).toMatchObject({ status: "valid", issues: [] });
    expect(
      evaluateSkillFrontmatter(
        '---\nname: openai-docs\ndescription: Official docs.\nmetadata:\n  short-description: "Codex and API documentation"\n---\n',
        harnessProfile("codex").frontmatter.default,
      ),
    ).toMatchObject({ status: "valid", issues: [] });
  });

  test("grounds Codex openai.yaml fields in documentation or first-party source", () => {
    const profile = harnessProfile("codex");
    const contract = profile.skillMetadata?.find((candidate) => candidate.default);
    expect(contract).toMatchObject({
      path: "agents/openai.yaml",
      consumer: "machine-or-harness",
      unknownFields: "ignored",
    });
    expect(contract?.fields.map((field) => field.path)).toContain(
      "policy.allow_implicit_invocation",
    );
    expect(contract?.fields.every((field) => field.sourceIds.length > 0)).toBe(true);
    expect(new Set(contract?.fields.map((field) => field.evidence))).toEqual(
      new Set(["documented", "first-party-source"]),
    );
  });

  test("accepts documented Claude frontmatter fallbacks and free-form metadata", () => {
    expect(
      evaluateSkillFrontmatter(
        "# Deploy\n\nDeploy safely.",
        harnessProfile("claude-code").frontmatter.default,
      ),
    ).toMatchObject({
      status: "valid",
      issues: [],
    });
    expect(
      evaluateSkillFrontmatter(
        "---\n---\nBody.\n",
        harnessProfile("claude-code").frontmatter.default,
      ),
    ).toMatchObject({
      status: "valid",
      issues: [],
    });
    expect(
      evaluateSkillFrontmatter(
        "---\ndescription: Use for tables formatted with ---\nname: tables\n---\n",
        harnessProfile("codex").frontmatter.default,
      ),
    ).toMatchObject({
      status: "valid",
      fields: { description: "Use for tables formatted with ---", name: "tables" },
      issues: [],
    });
    expect(
      evaluateSkillFrontmatter(
        "---\nmetadata:\n  version: 1\n---\n",
        harnessProfile("claude-code").frontmatter.default,
      ),
    ).toMatchObject({ status: "valid", issues: [] });
    expect(
      evaluateSkillFrontmatter(
        "---\nmetadata: [\n",
        harnessProfile("claude-code").frontmatter.default,
      ),
    ).toMatchObject({
      status: "invalid",
      issues: [expect.objectContaining({ code: "frontmatter-invalid" })],
    });
    expect(
      evaluateSkillFrontmatter(
        "---\nmetadata: hello\n---\n",
        harnessProfile("claude-code").frontmatter.default,
      ),
    ).toMatchObject({
      status: "valid",
      issues: [],
    });
  });

  test("keeps OpenCode V1 and V2 contracts distinct", () => {
    const profile = harnessProfile("opencode");
    expect([
      profile.frontmatter.default.variant,
      ...Object.values(profile.frontmatter.variants).map((contract) => contract.variant),
    ]).toEqual(["v1", "v2"]);
    expect(
      evaluateSkillFrontmatter(
        "---\nslash: false\n---\n",
        harnessProfile("opencode").frontmatter.variants.v2,
      ),
    ).toMatchObject({ status: "valid", variant: "v2" });
    expect(
      evaluateSkillFrontmatter(
        "---\ngarbage: true\n---\n",
        harnessProfile("opencode").frontmatter.variants.v2,
      ),
    ).toMatchObject({ status: "unknown", variant: "v2" });
    expect(
      evaluateSkillFrontmatter(
        "---\nlicense: [1]\n---\n",
        harnessProfile("opencode").frontmatter.variants.v2,
      ),
    ).toMatchObject({ status: "valid", issues: [] });
  });
});
