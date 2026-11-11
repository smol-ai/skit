import { result } from "../src/commands/result.js";
import { renderContract } from "../src/commands/output-presenters.js";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  PluginFailure,
  PluginManifestInvalid,
  PluginManifestInvalidReason,
  PluginSkillConflict,
} from "@smolai/skit-core/library/source/plugin-failures";
import { SourceDiscoveryDiagnostic } from "@smolai/skit-core/library/source";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { PnpmSkillManaged } from "@smolai/skit-core/installed-skills/pnpm-failures";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { sourceDiagnostic } from "../src/library/plugin-failures.js";
import { sourceDiagnostics } from "../src/library/presentation/source.js";
import { renderBlocks } from "../src/terminal/blocks.js";

it.effect("preserves every plugin declaration refusal through JSON and formats it in the CLI", () =>
  Effect.gen(function* () {
    const native = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.JsonObject)([]));
    const cases: {
      [K in PluginManifestInvalidReason["_tag"]]: Extract<PluginManifestInvalidReason, { _tag: K }>;
    } = {
      RelativePathInvalid: { _tag: "RelativePathInvalid", requested: "/outside" },
      SourceEscape: { _tag: "SourceEscape", root: "/source", selected: "/outside" },
      LinkEscape: { _tag: "LinkEscape", root: "/source", target: "/outside" },
      DeclaredPathMissing: { _tag: "DeclaredPathMissing" },
      ManifestNotFile: { _tag: "ManifestNotFile", kind: "Directory" },
      ManifestTooLarge: { _tag: "ManifestTooLarge", actual: 1_048_577, limit: 1_048_576 },
      InvalidJson: { _tag: "InvalidJson", failure: native },
      SkillPathsInvalid: { _tag: "SkillPathsInvalid", value: 42 },
      SkillPathEscape: { _tag: "SkillPathEscape", root: "/source/plugin", requested: "../outside" },
      SkillDirectoryRequired: { _tag: "SkillDirectoryRequired", kind: "File" },
      StrictInvalid: { _tag: "StrictInvalid", value: "false" },
      MarketplaceComponentsConflict: {
        _tag: "MarketplaceComponentsConflict",
        fields: ["skills", "commands"],
      },
      NameInvalid: { _tag: "NameInvalid", value: "" },
      PluginsArrayRequired: { _tag: "PluginsArrayRequired", value: {} },
      MarketplaceTooLarge: { _tag: "MarketplaceTooLarge", actual: 5001, limit: 5000 },
      PluginEntryInvalid: { _tag: "PluginEntryInvalid", value: 42 },
      PluginRootInvalid: { _tag: "PluginRootInvalid", value: true },
      LocalPathInvalid: { _tag: "LocalPathInvalid", value: 42 },
      PluginSourceMissing: { _tag: "PluginSourceMissing" },
    };
    for (const reason of Object.values(cases)) {
      const failure = new PluginManifestInvalid({ path: "/source/plugin.json", reason });
      if (failure.reason._tag === "InvalidJson") expect(failure.reason.failure).toBe(native);
      const wire = Schema.encodeSync(Schema.toCodecJson(PluginFailure))(failure);
      expect(wire).not.toHaveProperty("message");
      expect(wire).not.toHaveProperty("remediation");
      const decoded = Schema.decodeUnknownSync(PluginFailure)(JSON.parse(JSON.stringify(wire)));
      const formatted = classifyFailure(decoded);
      expect(formatted.message).toContain("/source/plugin.json");
      expect(formatted.message).not.toContain("[object Object]");
      expect(formatted.remediation).toContain("Correct the plugin declaration");
    }
    const nested = new SourceRestoreInvalid({
      hash: "sha256:retained",
      reason: {
        _tag: "SourceFetchFailed",
        failure: new PluginManifestInvalid({
          path: "/source/plugin.json",
          reason: cases.LinkEscape,
        }),
      },
    });
    const wire = Schema.encodeSync(Schema.toCodecJson(SourceRestoreInvalid))(nested);
    const decoded = Schema.decodeUnknownSync(SourceRestoreInvalid)(
      JSON.parse(JSON.stringify(wire)),
    );
    expect(classifyFailure(decoded).message).toContain("Link target /outside escapes");
  }),
);

it("keeps nonfatal plugin facts structured until the warning presenter", () => {
  const diagnostics: SourceDiscoveryDiagnostic[] = [
    {
      code: "plugin-manifest-invalid",
      path: "plugin.json",
      reason: { _tag: "MarketplaceComponentsConflict", fields: ["skills"] },
    },
    {
      code: "plugin-member-held",
      path: "plugins/new/skills/review",
      skillName: "review",
      retainedPath: "plugins/old/skills/review",
    },
  ];
  const wire = Schema.encodeSync(Schema.toCodecJson(Schema.Array(SourceDiscoveryDiagnostic)))(
    diagnostics,
  );
  expect(JSON.stringify(wire)).not.toContain('"message"');
  const stored = Schema.decodeUnknownSync(Schema.Array(SourceDiscoveryDiagnostic))(
    JSON.parse(JSON.stringify(wire)),
  );
  expect(sourceDiagnostic(stored[0])).toContain("strict:false");
  expect(sourceDiagnostic(stored[1])).toContain("plugins/old/skills/review");
  const text = renderBlocks(sourceDiagnostics(stored), { color: false });
  expect(text).toContain("plugins/new/skills/review");
  expect(text).toContain("strict:false");
});

it("formats ambiguous selections and installer ownership without asking core for words", () => {
  const conflict = classifyFailure(
    new PluginSkillConflict({
      skillName: "review",
      paths: ["a/review", "b/review"],
      directories: ["a", "b"],
      locators: ["https://git.test/a", "https://git.test/b"],
    }),
  );
  expect(conflict.message).toContain('"review" is ambiguous');
  expect(conflict.remediation).toContain("skit add 'https://git.test/a'");
  const installer = classifyFailure(
    new DedicatedInstallerRequired({
      sourceCoordinate: "github:pbakaus/impeccable",
      displayName: "Impeccable",
      command: "npx impeccable install",
      documentationUrl: "https://example.test/install",
    }),
  );
  expect(installer.remediation).toContain("npx impeccable install");
  const pnpm = classifyFailure(
    new PnpmSkillManaged({ path: "/work/guide", package: "@acme/demo" }),
  );
  expect(pnpm.message).toContain("managed by pnpm (@acme/demo)");
  expect(pnpm.code).toBe("CONFLICT");
});

it("does not claim everything is current when update left a conflicting member unselected", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const diagnostics: SourceDiscoveryDiagnostic[] = [
    {
      code: "plugin-member-held",
      path: "plugins/new/review",
      skillName: "review",
      retainedPath: "skills/review",
    },
  ];
  const common = {
    subject_id: "collection-review",
    subject_kind: "collection" as const,
    label: "review",
    changed: false,
    enabled: [],
    new_available: 0,
    updated: [],
    removed: [],
    kept: [],
  };
  const context = { color: false, detail: "full" as const };
  const plan = renderContract(
    result("updatePlan", [
      {
        ...common,
        current_snapshot_digest: digest,
        available_snapshot_digest: digest,
        diagnostics,
      },
    ]),
    context,
  );
  expect(plan).toContain("No selected changes");
  expect(plan).toContain("Kept existing Skill");
  expect(plan).not.toContain("Everything is current");
  const receipt = {
    ...common,
    previous_collection_version_id: "before",
    selected_collection_version_id: "after",
    snapshot_digest: digest,
    installed: 0,
  };
  const observed = renderContract(result("update", [{ ...receipt, diagnostics }]), context);
  expect(observed).toContain("Update checks found issues");
  expect(observed).not.toContain("Everything is current");
  const clear = renderContract(result("update", [receipt]), context);
  expect(clear).toContain("Everything is current");
});
