import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertHarnessCatalog,
  defaultSkillsRoot,
  evaluateSkillFrontmatter,
  harnessProfile,
  harnessProfileIds,
  harnessDocumentationFreshness,
  harnessCatalogFreshness,
  harnessRoot,
  projectionRoot,
  resolveHarnessRoot,
  type HarnessProfile,
} from "../src/index.js";

const harnessProfiles = Object.fromEntries(
  harnessProfileIds().map((id) => [id, harnessProfile(id)]),
);

describe("Harness Profile catalog", () => {
  test("profiles and projection targets are serializable and unique", () => {
    const profiles = Object.values(harnessProfiles);
    expect(new Set(profiles.map((item) => item.profile.id)).size).toBe(profiles.length);
    expect(() => JSON.stringify(profiles)).not.toThrow();
    for (const profile of profiles)
      for (const target of [profile.projection.globalTarget, profile.projection.projectTarget])
        if (target) expect(harnessRoot(profile, target).writable).toBe(true);
  });

  test("preserves the existing Codex compatibility projection target", () => {
    const profile = harnessProfile("codex");
    const target = harnessRoot(profile, profile.projection.globalTarget!);
    expect(target).toEqual(
      expect.objectContaining({ role: "compatibility", path: ".agents/skills", writable: true }),
    );
    expect(defaultSkillsRoot("codex")).toBe(join(homedir(), ".agents", "skills"));
    expect(profile.roots.find((root) => root.id === "codex-global-native")).toEqual(
      expect.objectContaining({ path: ".codex/skills", role: "native" }),
    );
    expect(harnessRoot(profile, "codex-project-agents")).toMatchObject({
      role: "compatibility",
      evidence: "observed",
      writable: true,
    });
    expect(harnessRoot(profile, "codex-project-codex")).toMatchObject({
      role: "native",
      evidence: "documented",
      writable: false,
    });
  });

  test("preserves the existing OpenCode projection root when XDG_CONFIG_HOME differs", () => {
    const context = { home: "/users/test", configHome: "/xdg/config" };
    expect(projectionRoot("opencode", "global", context)).toBe(
      resolve("/users/test/.config/opencode/skills"),
    );
    expect(
      resolveHarnessRoot(
        harnessRoot(harnessProfile("opencode"), "opencode-global-native"),
        context,
      ),
    ).toBe(resolve("/xdg/config/opencode/skills"));
  });

  test("does not invent a global Claude .agents compatibility root", () => {
    const roots = harnessProfile("claude-code").roots;
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

    expect(projectionRoot("devin", "global", context)).toBe(resolve("/xdg/config/devin/skills"));
    expect(projectionRoot("devin", "project", context)).toBe(
      resolve("/work/project/.devin/skills"),
    );
    expect(harnessRoot(profile, "devin-global-cognition")).toMatchObject({
      path: "cognition/skills",
      readable: true,
      writable: false,
    });
    expect(
      profile.roots.find((root) => root.scope === "project" && root.path === ".cognition/skills"),
    ).toMatchObject({ readable: true, writable: false });
    expect(harnessRoot(profile, "devin-global-agents")).toMatchObject({
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
    for (const profile of Object.values(harnessProfiles)) {
      const sources = new Set(profile.documentation.map((source) => source.id));
      for (const contract of profile.frontmatter)
        for (const field of contract.fields)
          expect(field.sourceIds.every((sourceId) => sources.has(sourceId))).toBe(true);
      for (const contract of profile.skillMetadata ?? [])
        for (const field of contract.fields)
          expect(field.sourceIds.every((sourceId) => sources.has(sourceId))).toBe(true);
    }
  });

  test("rejects duplicate root ids and projection targets with the wrong scope", () => {
    const profiles = structuredClone(harnessProfiles) as unknown as Record<string, HarnessProfile>;
    profiles.codex.roots[1].id = profiles.codex.roots[0].id;
    expect(() => assertHarnessCatalog(profiles)).toThrow("Duplicate root id");

    const wrongScope = structuredClone(harnessProfiles) as unknown as Record<
      string,
      HarnessProfile
    >;
    wrongScope.codex.projection.globalTarget = "codex-project-agents";
    expect(() => assertHarnessCatalog(wrongScope)).toThrow("Projection target has wrong scope");
  });

  test("validates profile-level invariants even when frontmatter is empty", () => {
    const profiles = structuredClone(harnessProfiles) as unknown as Record<string, HarnessProfile>;
    profiles.codex.frontmatter = [];
    expect(() => assertHarnessCatalog(profiles)).toThrow(
      "Exactly one default frontmatter contract",
    );
  });

  test("evaluates executable field constraints without rendering CLI prose", () => {
    const valid = evaluateSkillFrontmatter(
      "---\nname: code-review\ndescription: Review code.\n---\n",
      "opencode",
      { directoryName: "code-review" },
    );
    expect(valid).toMatchObject({ status: "valid", harness: "opencode", issues: [] });

    const invalid = evaluateSkillFrontmatter(
      "---\nname: Wrong--Name\ndescription: ''\n---\n",
      "opencode",
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
      evaluateSkillFrontmatter("---\nname: My_Skill\ndescription: Review.\n---\n", "codex", {
        directoryName: "different",
      }),
    ).toMatchObject({ status: "valid", issues: [] });
    expect(
      evaluateSkillFrontmatter(
        '---\nname: openai-docs\ndescription: Official docs.\nmetadata:\n  short-description: "Codex and API documentation"\n---\n',
        "codex",
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
    expect(evaluateSkillFrontmatter("# Deploy\n\nDeploy safely.", "claude-code")).toMatchObject({
      status: "valid",
      issues: [],
    });
    expect(evaluateSkillFrontmatter("---\n---\nBody.\n", "claude-code")).toMatchObject({
      status: "valid",
      issues: [],
    });
    expect(
      evaluateSkillFrontmatter(
        "---\ndescription: Use for tables formatted with ---\nname: tables\n---\n",
        "codex",
      ),
    ).toMatchObject({
      status: "valid",
      fields: { description: "Use for tables formatted with ---", name: "tables" },
      issues: [],
    });
    expect(
      evaluateSkillFrontmatter("---\nmetadata:\n  version: 1\n---\n", "claude-code"),
    ).toMatchObject({ status: "valid", issues: [] });
    expect(evaluateSkillFrontmatter("---\nmetadata: [\n", "claude-code")).toMatchObject({
      status: "invalid",
      issues: [expect.objectContaining({ code: "frontmatter-invalid" })],
    });
    expect(evaluateSkillFrontmatter("---\nmetadata: hello\n---\n", "claude-code")).toMatchObject({
      status: "valid",
      issues: [],
    });
  });

  test("keeps OpenCode V1 and V2 contracts distinct", () => {
    const profile = harnessProfile("opencode");
    expect(
      profile.frontmatter.map(({ variant, default: isDefault }) => [variant, isDefault]),
    ).toEqual([
      ["v1", true],
      ["v2", false],
    ]);
    expect(
      evaluateSkillFrontmatter("---\nslash: false\n---\n", "opencode", { variant: "v2" }),
    ).toMatchObject({ status: "valid", variant: "v2" });
    expect(
      evaluateSkillFrontmatter("---\ngarbage: true\n---\n", "opencode", { variant: "v2" }),
    ).toMatchObject({ status: "unknown", variant: "v2" });
    expect(
      evaluateSkillFrontmatter("---\nlicense: [1]\n---\n", "opencode", { variant: "v2" }),
    ).toMatchObject({ status: "valid", issues: [] });
  });
});
