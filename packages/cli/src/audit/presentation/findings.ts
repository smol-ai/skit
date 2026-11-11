import { AuditFindingReason, type AuditReportV1Alpha4 } from "@smolai/skit-core/audit";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { Block, type Inline } from "../../terminal/blocks.js";
import { ownershipMarkerInvalidReason } from "../../library/presentation/language.js";
import { severityHeadline } from "./language.js";
import { isAbsolute } from "node:path";

const configurationScope = { user: "user", project: "project" } satisfies Record<
  Extract<AuditFindingReason, { _tag: "CodexConfigurationInvalid" }>["scope"],
  string
>;

const frontmatterSummary = ({
  harness,
  issue,
}: Extract<AuditFindingReason, { _tag: "FrontmatterCompatibility" }>): readonly Inline[] => {
  const field: readonly Inline[] = issue.field === null ? ["a field"] : [{ code: issue.field }];
  const name = harnessLabel(harness);
  switch (issue.code) {
    case "frontmatter-invalid":
      return ["Skill frontmatter is not valid YAML metadata"];
    case "frontmatter-missing":
      return ["Skill frontmatter is missing"];
    case "field-unknown":
      return ["Skill frontmatter ", ...field, ` is not recognized by ${name}`];
    case "field-missing":
      return ["Skill frontmatter is missing ", ...field, ` required by ${name}`];
    case "field-type":
      return ["Skill frontmatter ", ...field, " has the wrong value type"];
    case "field-constraint":
      return ["Skill frontmatter ", ...field, ` does not meet ${name}'s requirements`];
  }
};

const summary = (reason: AuditFindingReason): readonly Inline[] =>
  AuditFindingReason.match(reason, {
    FrontmatterCompatibility: frontmatterSummary,
    AmbiguousLockfileAttribution: ({ skill }) => [
      "The installation records do not identify one source for skill ",
      { code: skill },
    ],
    CodexConfigurationInvalid: ({ scope }) => [
      `Codex ${configurationScope[scope]} configuration could not be parsed`,
    ],
    EnabledPluginFilesMissing: ({ harness, plugin }) => [
      `${harnessLabel(harness)} plugin `,
      { code: plugin },
      " is enabled, but its installed files were not found",
    ],
    InstalledPluginFilesMissing: ({ harness, plugin }) => [
      `${harnessLabel(harness)} plugin `,
      { code: plugin },
      " is registered as installed, but its files are missing",
    ],
    EnabledPluginNotInstalled: ({ harness, plugin }) => [
      `${harnessLabel(harness)} plugin `,
      { code: plugin },
      " is enabled but not installed",
    ],
    McpRegistrationUnsupported: ({ server }) => [
      "MCP server ",
      { code: server },
      " is registered in a location this audit does not support",
    ],
    LibraryUnreadable: () => ["SKIT Library state could not be read"],
    OwnershipMarkerInvalid: ({ reason }) => [ownershipMarkerInvalidReason(reason)],
    LibrarySkillMissing: () => ["The SKIT-managed folder has no matching skill in the Library"],
    McpRegistrationMissing: ({ server }) => [
      "Rules reference MCP server ",
      { code: server },
      ", but no supported registration was found",
    ],
  });

/** The audit owner provides facts; this frontend formats each finding with semantic fields. */
export const auditFinding = (finding: AuditReportV1Alpha4["findings"][number]): Block =>
  Block.Group({
    title: severityHeadline(finding.severity),
    children: [
      ...(finding.unresolvedSubject
        ? [
            Block.Note({
              text: [
                isAbsolute(finding.unresolvedSubject)
                  ? { path: finding.unresolvedSubject }
                  : { code: finding.unresolvedSubject },
              ],
            }),
          ]
        : []),
      Block.Fields({
        rows: [
          { label: "Problem", value: summary(finding.reason) },
          ...(finding.reason._tag === "CodexConfigurationInvalid"
            ? [
                { label: "Line", value: [String(finding.reason.issue.line)] },
                {
                  label: "Reason",
                  value: [
                    {
                      UnsupportedLine: "SKIT cannot read this configuration syntax",
                      UnterminatedKey: "A quoted key is not closed",
                      InvalidValue: "A quoted value is invalid",
                    }[finding.reason.issue._tag],
                  ],
                },
              ]
            : []),
          {
            label: "Where",
            value: finding.locations.flatMap((path, index) => [...(index ? ["\n"] : []), { path }]),
          },
        ],
      }),
    ],
  });
