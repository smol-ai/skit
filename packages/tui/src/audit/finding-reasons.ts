import { AuditFindingReason } from "@smolai/skit-core/audit";
import { harnessLabel } from "@smolai/skit-core/harnesses";
const configurationScope = { user: "user", project: "project" } satisfies Record<
  Extract<AuditFindingReason, { _tag: "CodexConfigurationInvalid" }>["scope"],
  string
>;

const frontmatter = ({
  harness,
  issue,
}: Extract<AuditFindingReason, { _tag: "FrontmatterCompatibility" }>): string => {
  const field = issue.field === null ? "a field" : issue.field;
  const name = harnessLabel(harness);
  switch (issue.code) {
    case "frontmatter-invalid":
      return "Skill frontmatter is not valid YAML metadata";
    case "frontmatter-missing":
      return "Skill frontmatter is missing";
    case "field-unknown":
      return `Skill frontmatter ${field} is not recognized by ${name}`;
    case "field-missing":
      return `Skill frontmatter is missing ${field} required by ${name}`;
    case "field-type":
      return `Skill frontmatter ${field} has the wrong value type`;
    case "field-constraint":
      return `Skill frontmatter ${field} does not meet ${name}'s requirements`;
  }
};

export const auditFindingText = (reason: AuditFindingReason): string =>
  AuditFindingReason.match(reason, {
    FrontmatterCompatibility: frontmatter,
    AmbiguousLockfileAttribution: ({ skill }) =>
      `The installation records do not identify one source for skill ${skill}`,
    CodexConfigurationInvalid: ({ scope, issue }) =>
      `Codex ${configurationScope[scope]} configuration could not be parsed: ${
        {
          UnsupportedLine: "SKIT cannot read this configuration syntax",
          UnterminatedKey: "a quoted key is not closed",
          InvalidValue: "a quoted value is invalid",
        }[issue._tag]
      } (line ${issue.line})`,
    EnabledPluginFilesMissing: ({ harness, plugin }) =>
      `${harnessLabel(harness)} plugin ${plugin} is enabled, but its installed files were not found`,
    InstalledPluginFilesMissing: ({ harness, plugin }) =>
      `${harnessLabel(harness)} plugin ${plugin} is registered as installed, but its files are missing`,
    EnabledPluginNotInstalled: ({ harness, plugin }) =>
      `${harnessLabel(harness)} plugin ${plugin} is enabled but not installed`,
    McpRegistrationUnsupported: ({ server }) =>
      `MCP server ${server} is registered in a location this audit does not support`,
    LibraryUnreadable: () => "SKIT Library state could not be read",
    OwnershipMarkerInvalid: ({ reason }) => {
      switch (reason._tag) {
        case "NotObject":
          return "The ownership marker must contain a JSON object.";
        case "InvalidJson":
          return "The ownership marker is not valid JSON.";
        case "InvalidFields":
          return "The ownership marker's fields do not match a supported SKIT format.";
      }
    },
    LibrarySkillMissing: () => "The SKIT-managed folder has no matching skill in the Library",
    McpRegistrationMissing: ({ server }) =>
      `Rules reference MCP server ${server}, but no supported registration was found`,
  });
