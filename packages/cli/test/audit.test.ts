import { dirname, isAbsolute, join } from "node:path";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import {
  makeCollectionId,
  makeProjectionId,
  makeSkillId,
  makeSkillVersionId,
  skitLayer,
} from "@smolai/skit-core";
import {
  auditLocalCapabilitiesEffect,
  auditLocalCapabilitiesV1Alpha4Effect,
} from "../src/audit/local.js";
import { AuditReportV1Alpha4 } from "../src/audit/schema.js";
import { normalizeAuditReport } from "../src/audit/normalize.js";
import { outputContracts } from "../src/commands/output-contracts.js";

const scratch = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));
const write = Effect.fn("Test.write")(function* (path: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dirname(path), { recursive: true });
  yield* fs.writeFileString(path, content);
});
const makeDir = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory(path, { recursive: true }));
const link = (target: string, path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(target, path));

describe("experimental capability audit", () => {
  it.effect("validates typed static Skill evidence in both audit contracts", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-contract-");
      const skill = join(root, "home", ".agents", "skills", "review", "SKILL.md");
      yield* write(
        skill,
        '---\nname: review\ndescription: Review code.\n---\n\nCall spawn("sh").\n',
      );
      const report = yield* auditLocalCapabilitiesV1Alpha4Effect({
        home: join(root, "home"),
        cwd: root,
      });
      const staticAudit = report.skills.find((item) => item.name === "review")?.staticAudit;

      expect(staticAudit?.findings[0]).toEqual(
        expect.objectContaining({
          ruleId: "process.api-execution",
          confidence: "high",
          location: expect.objectContaining({ path: skill, line: 6, column: 6 }),
        }),
      );
      expect(Schema.is(AuditReportV1Alpha4)(report)).toBe(true);
      expect(Schema.is(outputContracts.experimentalAuditV1Alpha4.schema)(report)).toBe(true);
      const futureRuleset = structuredClone(report);
      Reflect.set(
        futureRuleset.skills.find((item) => item.name === "review")!.staticAudit!.ruleset,
        "version",
        "0.3.0",
      );
      expect(Schema.is(AuditReportV1Alpha4)(futureRuleset)).toBe(true);

      const malformed = structuredClone(report);
      const finding = malformed.skills.find((item) => item.name === "review")!.staticAudit!
        .findings[0];
      Reflect.set(finding, "confidence", "certain");
      Reflect.set(finding.location, "line", "six");
      expect(Schema.is(AuditReportV1Alpha4)(malformed)).toBe(false);
      expect(Schema.is(outputContracts.experimentalAuditV1Alpha4.schema)(malformed)).toBe(false);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("attributes Codex system skills to their bundled source", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const skill = join(home, ".codex", "skills", ".system", "imagegen", "SKILL.md");
      yield* write(
        skill,
        '---\nname: imagegen\ndescription: Generate images.\nmetadata:\n  short-description: "Generate and edit images"\n---\n',
      );

      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      const observed = report.observations.find(
        (item) => item.kind === "skill" && item.path === skill,
      );

      expect(observed?.provenance).toEqual({
        confidence: "exact",
        source: "Codex system skills",
        evidence: join(home, ".codex", "skills", ".system"),
      });
      expect(
        report.findings.filter(
          (finding) => finding.subject === "imagegen" && finding.code === "skill-field-unknown",
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("joins canonical skill aliases and Skills CLI provenance", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const canonical = join(home, ".agents", "skills", "review");
      const alias = join(home, ".claude", "skills", "review");
      yield* write(join(canonical, "SKILL.md"), "---\nname: review\n---\nReview files.");
      yield* makeDir(dirname(alias));
      yield* link(canonical, alias);
      yield* write(
        join(home, ".agents", ".skill-lock.json"),
        JSON.stringify({ skills: { review: { sourceUrl: "https://example.test/review" } } }),
      );

      yield* TestClock.setTime(new Date("2026-01-01T00:00:00.000Z").getTime());
      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      const skills = report.observations.filter((item) => item.kind === "skill");
      expect(skills).toHaveLength(2);
      expect(new Set(skills.map((item) => item.canonicalPath)).size).toBe(1);
      expect(skills.every((item) => item.aliases?.length === 2)).toBe(true);
      expect(skills.every((item) => item.provenance.source === "Skills CLI / skills.sh")).toBe(
        true,
      );
      expect(
        skills
          .flatMap((item) => item.frontmatterCompatibility ?? [])
          .map((item) => ({
            harness: item.harness,
            status: item.status,
            contractId: item.contractId,
          })),
      ).toEqual([
        expect.objectContaining({ harness: "claude-code", status: "valid" }),
        expect.objectContaining({ harness: "codex", status: "invalid" }),
        expect.objectContaining({ harness: "devin", status: "valid" }),
      ]);
      expect(skills.map((item) => item.harnesses)).toEqual([["claude-code"], ["codex", "devin"]]);
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: "skill-field-missing",
          details: expect.objectContaining({ harness: "codex", field: "description" }),
        }),
      );
      expect(
        report.coverage.supported
          .flatMap((profile) => profile.documentation)
          .every((source) => source.kind === "observed" || source.url !== null),
      ).toBe(true);
      expect(report.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect(
    "attributes a valid ownership marker without a retained Collection as an orphan claim",
    () =>
      Effect.gen(function* () {
        const root = yield* scratch("skit-audit-");
        const home = join(root, "home");
        const skill = join(home, ".agents", "skills", "ask-matt");
        yield* write(join(skill, "SKILL.md"), "---\nname: ask-matt\ndescription: Ask Matt.\n---\n");
        yield* write(
          join(skill, ".skit-ownership.json"),
          JSON.stringify({
            schemaVersion: 2,
            projectionPolicyVersion: 1,
            projection_id: makeProjectionId(),
            collection_id: makeCollectionId(),
            skill_id: makeSkillId(),
            skill_version_id: makeSkillVersionId(),
            expected_digest: `sha256:${"a".repeat(64)}`,
            harness: "codex",
          }),
        );
        yield* write(
          join(home, ".skit", "state.json"),
          JSON.stringify({
            schemaVersion: 5,
            skills: [],
          }),
        );

        const observed = (yield* auditLocalCapabilitiesEffect({
          home,
          cwd: root,
        })).observations.find((item) => item.kind === "skill" && item.name === "ask-matt");
        expect(observed?.provenance).toMatchObject({
          confidence: "matched",
          source: "SKIT orphan claim",
          evidence: join(skill, ".skit-ownership.json"),
          expectedHash: `sha256:${"a".repeat(64)}`,
        });
        expect(observed?.provenance.transactionId).toBeUndefined();

        const report = yield* auditLocalCapabilitiesV1Alpha4Effect({ home, cwd: root });
        expect(Schema.is(outputContracts.experimentalAuditV1Alpha4.schema)(report)).toBe(true);
      }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports unretained and invalid ownership markers as custody findings", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-custody-");
      const home = join(root, "home");
      const orphan = join(home, ".agents", "skills", "orphan");
      const invalid = join(home, ".agents", "skills", "invalid");
      yield* write(join(orphan, "SKILL.md"), "---\nname: orphan\ndescription: Orphan.\n---\n");
      yield* write(
        join(orphan, ".skit-ownership.json"),
        JSON.stringify({
          schemaVersion: 2,
          projectionPolicyVersion: 1,
          projection_id: makeProjectionId(),
          collection_id: makeCollectionId(),
          skill_id: makeSkillId(),
          skill_version_id: makeSkillVersionId(),
          expected_digest: `sha256:${"a".repeat(64)}`,
          harness: "codex",
        }),
      );
      yield* write(join(invalid, "SKILL.md"), "---\nname: invalid\ndescription: Invalid.\n---\n");
      yield* write(join(invalid, ".skit-ownership.json"), "{}");

      const report = yield* auditLocalCapabilitiesV1Alpha4Effect({ home, cwd: root });

      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            code: "orphaned-projection-claim",
            entryIds: [expect.any(String)],
            details: expect.objectContaining({
              destructiveAuthority: false,
            }),
          }),
          expect.objectContaining({
            severity: "error",
            code: "invalid-ownership-marker",
            entryIds: [expect.any(String)],
          }),
        ]),
      );
      expect(report.skills.find((skill) => skill.name === "invalid")?.provenance.source).not.toBe(
        "SKIT projection",
      );
      const orphanProvenance = report.skills.find((skill) => skill.name === "orphan")?.provenance;
      expect(orphanProvenance).toEqual(expect.objectContaining({ source: "SKIT orphan claim" }));
      expect(orphanProvenance).not.toHaveProperty("collectionId");
      expect(orphanProvenance).not.toHaveProperty("transactionId");
      expect(report.skills.find((skill) => skill.name === "orphan")?.harnessIds).toEqual([
        "codex",
        "devin",
      ]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports an unreadable ledger without misclassifying every marker as orphaned", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-ledger-");
      const home = join(root, "home");
      const skill = join(home, ".agents", "skills", "retained");
      yield* write(join(skill, "SKILL.md"), "---\nname: retained\ndescription: Retained.\n---\n");
      yield* write(
        join(skill, ".skit-ownership.json"),
        JSON.stringify({
          schemaVersion: 3,
          projectionPolicyVersion: 1,
          projection_id: makeProjectionId(),
          skill_id: makeSkillId(),
          skill_version_id: makeSkillVersionId(),
          expected_digest: `sha256:${"a".repeat(64)}`,
          harness: "codex",
        }),
      );
      yield* write(join(home, ".skit", "state.json"), "{");

      const report = yield* auditLocalCapabilitiesV1Alpha4Effect({ home, cwd: root });

      expect(report.findings).toContainEqual(
        expect.objectContaining({ severity: "error", code: "unreadable-library-ledger" }),
      );
      expect(report.findings.some((finding) => finding.code === "orphaned-projection-claim")).toBe(
        false,
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reports a readable version-1 ledger as requiring migration", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-migration-");
      const home = join(root, "home");
      yield* write(
        join(home, ".skit", "state.json"),
        JSON.stringify({ schemaVersion: 1, entries: [], installations: [] }),
      );

      const report = yield* auditLocalCapabilitiesV1Alpha4Effect({ home, cwd: root });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          severity: "error",
          code: "migration-required",
          details: { code: "MIGRATION_REQUIRED", fromVersion: 1, toVersion: 2 },
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("separates Codex configured, cached, and MCP state", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      yield* write(
        join(home, ".codex", "config.toml"),
        `[marketplaces.vendor]\nsource = "https://example.test/plugins"\n[plugins."enabled@vendor"]\nenabled = true\n[plugins."missing@vendor"]\nenabled = true\n[mcp_servers.review]\ncommand = "review-server"\nargs = ["--stdio"]\ncwd = "/tmp/review"\n[mcp_servers.review.env]\nTOKEN = "not-a-server"\n[tui]\nenabled = false\n`,
      );
      yield* write(
        join(
          home,
          ".codex",
          "plugins",
          "cache",
          "vendor",
          "enabled",
          "1.0.0",
          ".codex-plugin",
          "plugin.json",
        ),
        JSON.stringify({ version: "1.0.0" }),
      );

      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      expect(
        report.observations
          .filter((item) => item.kind === "plugin")
          .map(({ name, installed, enabled }) => ({ name, installed, enabled })),
      ).toEqual([
        { name: "enabled@vendor", installed: true, enabled: true },
        { name: "missing@vendor", installed: false, enabled: true },
      ]);
      expect(
        report.observations.filter((item) => item.kind === "mcp-server").map((item) => item.name),
      ).toEqual(["review"]);
      expect(report.observations.find((item) => item.kind === "mcp-server")?.mcp).toEqual({
        transport: "stdio",
        command: "review-server",
        args: ["--stdio"],
        cwd: "/tmp/review",
      });
      expect(report.findings.map((item) => item.code)).toEqual(["enabled-codex-plugin-not-cached"]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("audits project Codex configuration only for a trusted cwd", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const cwd = join(root, "project");
      yield* write(
        join(cwd, ".codex", "config.toml"),
        `[mcp_servers.project-review]\ncommand = "project-review-server"\n`,
      );
      yield* write(
        join(home, ".codex", "config.toml"),
        `[projects."${cwd}"]\ntrust_level = "untrusted"\n`,
      );
      expect(
        (yield* auditLocalCapabilitiesEffect({ home, cwd })).observations.some(
          (item) => item.kind === "mcp-server" && item.name === "project-review",
        ),
      ).toBe(false);

      yield* write(
        join(home, ".codex", "config.toml"),
        `[projects."${cwd}"]\ntrust_level = "trusted"\n`,
      );
      expect((yield* auditLocalCapabilitiesEffect({ home, cwd })).observations).toContainEqual(
        expect.objectContaining({
          kind: "mcp-server",
          name: "project-review",
          scope: "project",
          path: join(cwd, ".codex", "config.toml"),
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("matches Codex project trust through a symlinked cwd", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const project = join(root, "project");
      const linked = join(root, "linked-project");
      yield* write(
        join(project, ".codex", "config.toml"),
        `[mcp_servers.project-review]\ncommand = "project-review-server"\n`,
      );
      yield* link(project, linked);
      yield* write(
        join(home, ".codex", "config.toml"),
        `[projects."${project}"]\ntrust_level = "trusted"\n`,
      );
      expect(
        (yield* auditLocalCapabilitiesEffect({ home, cwd: linked })).observations,
      ).toContainEqual(
        expect.objectContaining({ kind: "mcp-server", name: "project-review", scope: "project" }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("reconciles plugin payload skills with the root skill inventory", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const canonical = join(home, ".agents", "skills", "review");
      const installPath = join(home, ".claude", "plugins", "cache", "vendor", "review", "1.0.0");
      yield* write(join(canonical, "SKILL.md"), "---\nname: review\n---\nReview files.");
      yield* makeDir(join(installPath, "skills"));
      yield* link(canonical, join(installPath, "skills", "review"));
      yield* write(
        join(home, ".agents", ".skill-lock.json"),
        JSON.stringify({ skills: { review: { sourceUrl: "https://example.test/review" } } }),
      );
      yield* write(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "review@vendor": [{ scope: "user", installPath }] } }),
      );

      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      const skills = report.observations.filter(
        (item) => item.kind === "skill" && item.name.includes("review"),
      );
      expect(skills).toHaveLength(2);
      expect(new Set(skills.map((item) => item.canonicalPath)).size).toBe(1);
      expect(skills.every((item) => item.aliases?.length === 2)).toBe(true);
      expect(skills.every((item) => item.provenance.source === "Skills CLI / skills.sh")).toBe(
        true,
      );
      expect(skills.find((item) => item.name.includes(":"))?.provenance.parentPlugin).toBe(
        "review@vendor",
      );
      expect(skills.find((item) => item.name.includes(":"))?.role).toBe("native");
      expect(report.coverage.deferred).not.toContain("devin");
      expect(report.coverage.supported.map((item) => item.id)).toContain("devin");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("ownership markers override plugin provenance while retaining the parent plugin", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const installPath = join(home, ".claude", "plugins", "cache", "vendor", "review", "1.0.0");
      const skill = join(installPath, "skills", "review");
      yield* write(join(skill, "SKILL.md"), "---\nname: review\n---\nReview files.");
      yield* write(
        join(skill, ".skit-ownership.json"),
        JSON.stringify({
          schemaVersion: 2,
          projectionPolicyVersion: 1,
          projection_id: makeProjectionId(),
          collection_id: makeCollectionId(),
          skill_id: makeSkillId(),
          skill_version_id: makeSkillVersionId(),
          expected_digest: `sha256:${"a".repeat(64)}`,
          harness: "claude-code",
        }),
      );
      yield* write(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "review@vendor": [{ scope: "user", installPath }] } }),
      );
      yield* write(
        join(home, ".skit", "state.json"),
        JSON.stringify({
          schemaVersion: 5,
          skills: [],
        }),
      );

      const observed = (yield* auditLocalCapabilitiesEffect({ home, cwd: root })).observations.find(
        (item) => item.kind === "skill" && item.name === "review@vendor:review",
      );
      expect(observed?.provenance).toEqual(
        expect.objectContaining({
          source: "SKIT orphan claim",
          parentPlugin: "review@vendor",
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect(
    "does not apply a root lock entry to an unrelated plugin skill with the same name",
    () =>
      Effect.gen(function* () {
        const root = yield* scratch("skit-audit-");
        const home = join(root, "home");
        const installPath = join(home, ".claude", "plugins", "cache", "vendor", "review", "1.0.0");
        yield* write(join(home, ".agents", "skills", "review", "SKILL.md"), "Review root.");
        yield* write(join(installPath, "skills", "review", "SKILL.md"), "Review plugin.");
        yield* write(
          join(home, ".agents", ".skill-lock.json"),
          JSON.stringify({ skills: { review: { sourceUrl: "https://example.test/review" } } }),
        );
        yield* write(
          join(home, ".claude", "plugins", "installed_plugins.json"),
          JSON.stringify({ plugins: { "review@vendor": [{ scope: "user", installPath }] } }),
        );

        const pluginSkill = (yield* auditLocalCapabilitiesEffect({
          home,
          cwd: root,
        })).observations.find(
          (item) => item.kind === "skill" && item.name === "review@vendor:review",
        );
        expect(pluginSkill?.provenance).toEqual(
          expect.objectContaining({
            source: "Claude plugin registry",
            parentPlugin: "review@vendor",
          }),
        );
      }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("discards partial Codex state after a parse failure", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      yield* write(
        join(home, ".codex", "config.toml"),
        `[mcp_servers.phantom]\ncommand = "server"\nthis is not toml\n`,
      );
      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      expect(report.observations.filter((item) => item.kind === "mcp-server")).toEqual([]);
      expect(report.findings.map((item) => item.code)).toEqual(["codex-config-parse-failed"]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("discovers Claude plugin installation state", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const installPath = join(home, ".claude", "plugins", "cache", "review", "1.0.0");
      yield* write(join(installPath, "skills", "review", "SKILL.md"), "Review files.");
      yield* write(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: { review: [{ scope: "user", version: "1.0.0", installPath }] },
        }),
      );
      yield* write(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ enabledPlugins: { review: true } }),
      );
      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      expect(
        report.observations
          .filter((item) => item.kind === "plugin" && item.harnesses.includes("claude-code"))
          .map(({ name, installed, enabled }) => ({ name, installed, enabled })),
      ).toEqual([{ name: "review", installed: true, enabled: true }]);
      expect(
        report.observations.find((item) => item.kind === "skill" && item.name === "review:review")
          ?.provenance.parentPlugin,
      ).toBe("review");
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("missing plugin roots cannot escape into the process working directory", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const auditedCwd = join(root, "audited");
      yield* write(join(root, "skills", "leaked", "SKILL.md"), "Must not be discovered.");
      yield* write(
        join(root, ".claude-plugin", "marketplace.json"),
        JSON.stringify({ plugins: [{ name: "ghost", defaultEnabled: true }] }),
      );
      yield* write(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { noPath: [{ scope: "user" }] } }),
      );
      yield* write(
        join(home, ".claude", "plugins", "known_marketplaces.json"),
        JSON.stringify({ vendor: { source: { repo: "example/vendor" } } }),
      );
      const previous = process.cwd();
      process.chdir(root);
      try {
        const report = yield* auditLocalCapabilitiesEffect({ home, cwd: auditedCwd });
        expect(report.observations.some((item) => item.name.includes("leaked"))).toBe(false);
        expect(report.observations.some((item) => item.name === "ghost@vendor")).toBe(false);
        expect(
          report.observations.every((item) => item.path === null || isAbsolute(item.path)),
        ).toBe(true);
      } finally {
        process.chdir(previous);
      }
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("groups rule references when their MCP registration is absent", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const first = join(home, ".claude", "rules", "delegate.md");
      const second = join(home, ".claude", "rules", "review.md");
      yield* write(first, "Use mcp__reviewer__review when needed.");
      yield* write(second, "Call mcp__reviewer__reply for follow-up.");
      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });
      expect(report.findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "advertised-mcp-not-configured",
          subject: "reviewer",
          locations: [first, second],
          details: {
            server: "reviewer",
            advertisingPaths: [first, second],
          },
        }),
      ]);
      expect(normalizeAuditReport(report).findings).toEqual([
        expect.objectContaining({
          entryIds: [],
          unresolvedSubject: "reviewer",
          details: { server: "reviewer", advertisingPaths: [first, second] },
        }),
      ]);
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("recognizes a disabled MCP registration without claiming it is absent", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      yield* write(
        join(home, ".claude", "rules", "delegate.md"),
        "Use mcp__reviewer__review when needed.",
      );
      yield* write(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { reviewer: { command: "reviewer", enabled: false } },
        }),
      );

      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });

      expect(report.findings).toEqual([]);
      expect(report.observations).toContainEqual(
        expect.objectContaining({
          kind: "mcp-server",
          name: "reviewer",
          enabled: false,
          active: false,
        }),
      );
    }).pipe(Effect.provide(skitLayer)),
  );

  it.effect("folds rule references into an unsupported-location MCP finding", () =>
    Effect.gen(function* () {
      const root = yield* scratch("skit-audit-");
      const home = join(root, "home");
      const rule = join(home, ".claude", "rules", "delegate.md");
      yield* write(rule, "Use mcp__reviewer__review when needed.");
      yield* write(
        join(home, ".claude", "settings.json"),
        JSON.stringify({ mcpServers: { reviewer: { command: "reviewer" } } }),
      );

      const report = yield* auditLocalCapabilitiesEffect({ home, cwd: root });

      expect(report.findings).toEqual([
        expect.objectContaining({
          code: "claude-mcp-registration-unsupported-location",
          subject: "reviewer",
          details: expect.objectContaining({ server: "reviewer", advertisingPaths: [rule] }),
        }),
      ]);
    }).pipe(Effect.provide(skitLayer)),
  );
});
