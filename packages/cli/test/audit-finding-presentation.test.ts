import { expect, test } from "vitest";
import { auditFinding } from "../src/audit/presentation/findings.js";
import { Block } from "../src/terminal/blocks.js";

const finding = {
  id: "finding:config",
  severity: "warning" as const,
  code: "codex-config-parse-failed",
  entryIds: [],
  unresolvedSubject: null,
  locations: ["/home/person/.codex/config.toml"],
  details: {},
};

test("configuration findings expose the actual line and typed condition as semantic fields", () => {
  expect(
    auditFinding({
      ...finding,
      reason: {
        _tag: "CodexConfigurationInvalid",
        scope: "user",
        issue: { _tag: "UnsupportedLine", line: 3 },
      },
    }),
  ).toEqual(
    Block.Group({
      title: "Warning",
      children: [
        Block.Fields({
          rows: [
            { label: "Problem", value: ["Codex user configuration could not be parsed"] },
            { label: "Line", value: ["3"] },
            { label: "Reason", value: ["SKIT cannot read this configuration syntax"] },
            { label: "Where", value: [{ path: "/home/person/.codex/config.toml" }] },
          ],
        }),
      ],
    }),
  );
});

test("frontmatter findings identify the actual Harness and keep the field name semantic", () => {
  const output = auditFinding({
    ...finding,
    reason: {
      _tag: "FrontmatterCompatibility",
      harness: "codex",
      issue: { code: "field-unknown", field: "metadata", severity: "unknown", sourceIds: [] },
    },
  });
  if (output._tag !== "Group") throw new Error("Expected one finding group");
  expect(output.children).toContainEqual(
    Block.Fields({
      rows: [
        {
          label: "Problem",
          value: ["Skill frontmatter ", { code: "metadata" }, " is not recognized by Codex"],
        },
        { label: "Where", value: [{ path: "/home/person/.codex/config.toml" }] },
      ],
    }),
  );
});
