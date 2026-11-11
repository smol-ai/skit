import {
  PluginFailure,
  PluginManifestInvalidReason,
} from "@smolai/skit-core/library/source/plugin-failures";
import { Match } from "effect";
import { schemaFailure } from "./schema-failure";

const pluginManifestReason = (reason: PluginManifestInvalidReason): string =>
  PluginManifestInvalidReason.match(reason, {
    RelativePathInvalid: ({ requested }) => `Invalid relative path: ${JSON.stringify(requested)}`,
    SourceEscape: ({ selected, root }) => `Path ${selected} escapes the Source at ${root}`,
    LinkEscape: ({ target, root }) => `Link target ${target} escapes the Source at ${root}`,
    DeclaredPathMissing: () => "Declared path is missing",
    ManifestNotFile: ({ kind }) => `Expected a JSON file; found ${kind.toLowerCase()}`,
    ManifestTooLarge: ({ actual, limit }) => `Manifest is ${actual} bytes; limit is ${limit}`,
    InvalidJson: ({ failure }) => `Expected a JSON object: ${schemaFailure(failure)}`,
    SkillPathsInvalid: ({ value }) =>
      `skills must be a path or array of paths; received ${JSON.stringify(value)}`,
    SkillPathEscape: ({ requested, root }) =>
      `Skill path ${requested} escapes the plugin root at ${root}`,
    SkillDirectoryRequired: ({ kind }) => `Expected a Skill directory; found ${kind.toLowerCase()}`,
    StrictInvalid: ({ value }) => `strict must be boolean; received ${JSON.stringify(value)}`,
    MarketplaceComponentsConflict: ({ fields }) =>
      `Marketplace entry conflicts with the plugin manifest under strict:false; conflicting fields: ${fields.join(", ")}`,
    NameInvalid: ({ value }) =>
      `Expected a nonempty plugin name; received ${JSON.stringify(value)}`,
    PluginsArrayRequired: () => "plugins must be an array",
    MarketplaceTooLarge: ({ actual, limit }) =>
      `Marketplace contains ${actual} entries; limit is ${limit}`,
    PluginEntryInvalid: ({ value }) =>
      `Expected a plugin entry object; received ${JSON.stringify(value)}`,
    PluginRootInvalid: ({ value }) =>
      `metadata.pluginRoot must be a path; received ${JSON.stringify(value)}`,
    LocalPathInvalid: () => "Local source requires a path",
    PluginSourceMissing: () => "Plugin entry requires a source",
  });

export const pluginFailure = Match.type<PluginFailure>().pipe(
  Match.tagsExhaustive({
    PluginManifestInvalid: ({ path, reason }) => ({
      message: `Invalid plugin declaration at ${path}: ${pluginManifestReason(reason)}`,
      remediation: `Correct the plugin declaration at ${path}, then retry.`,
    }),
    PluginSkillConflict: ({ skillName, paths, locators, directories }) => ({
      message: `Skill name ${JSON.stringify(skillName)} is ambiguous at ${paths.map((path) => JSON.stringify(path)).join(" and ")}`,
      remediation: `Select the plugin or Skill directory explicitly. Available selections: ${(locators ?? directories).join("; ")}`,
    }),
  }),
);
