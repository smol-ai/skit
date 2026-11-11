import { describe, expect, it } from "vitest";
import { presentContract } from "../src/commands/output-presenters.js";
import { result } from "../src/commands/result.js";
import { OutputStory, outputStories, outputStoryKey } from "../src/storybook/output-stories.js";
import { Block } from "../src/terminal/blocks.js";

const summary = { color: false, detail: "summary" } as const;
const revision = `sha256:${"a".repeat(64)}`;
const identity = {
  authority: "registry.example",
  namespace: "smol-ai",
  skit: "review-tools",
  locator: "registry.example/smol-ai/review-tools",
};

describe("contract presenters", () => {
  it("says each validation diagnostic as an outcome with its severity and path", () => {
    expect(
      presentContract(
        result("validate", {
          valid: false,
          status: "invalid",
          identity: {
            slug: "review-tools",
            release: "1.2.0",
            releaseContentHash: revision,
            skills: [],
          },
          diagnostics: [
            { code: "SKILL_FILE_MISSING", severity: "warning", path: "skills/x/SKILL.md" },
          ],
          audits: {},
          assessments: {},
        }),
        summary,
      ),
    ).toEqual([
      Block.Status({ tone: "error", text: ["SKIT validation failed"] }),
      Block.Status({
        tone: "warn",
        text: ["Contained skills require a primary SKILL.md", " ", { dim: "(skills/x/SKILL.md)" }],
      }),
    ]);
  });

  it("splits an author sync preview into its outcome and the command that applies it", () => {
    expect(
      presentContract(
        result("sync", {
          status: "first_sync_ready",
          changed: false,
          identity,
          visibility: "private",
          file_count: 2,
          effects: ["create_skit", "save_revision"],
        }),
        summary,
      ),
    ).toEqual([
      Block.Status({ tone: "info", text: [`Sync ready for ${identity.locator} (private)`] }),
      Block.Note({ text: ["No Release will be published."] }),
      Block.Note({ text: ["Rerun with ", { code: "--apply" }, "."] }),
    ]);
    expect(
      presentContract(
        result("sync", {
          status: "created",
          changed: true,
          identity,
          visibility: "private",
          revision_id: revision,
          paths: [],
          remote_home_recorded: true,
          published: false,
        }),
        summary,
      ),
    ).toEqual([
      Block.Status({ tone: "ok", text: [`Connected ${identity.locator}`] }),
      // A revision is shown shortened, as a person refers to it.
      Block.Fields({ rows: [{ label: "Saved revision", value: [revision.slice(0, 19)] }] }),
    ]);
  });

  it("copies a completion script exactly", () => {
    expect(
      presentContract(
        result("completions", { shell: "bash", script: "complete -F _skit skit" }),
        summary,
      ),
    ).toEqual([Block.Verbatim({ text: "complete -F _skit skit" })]);
  });

  it("titles each audit finding by severity with its subject and semantic location", () => {
    const story = outputStories
      .filter(OutputStory.$is("Result"))
      .find((candidate) => outputStoryKey(candidate) === "audit/findings-v1alpha4")!;
    const blocks = presentContract(story.result, summary);
    expect(blocks).toContainEqual(
      Block.Group({
        title: "Warning",
        children: [
          Block.Note({ text: [{ code: "reviewer" }] }),
          Block.Fields({
            rows: [
              {
                label: "Problem",
                value: [
                  "Rules reference MCP server ",
                  { code: "reviewer" },
                  ", but no supported registration was found",
                ],
              },
              { label: "Where", value: [{ path: "/home/story/.claude/rules/delegate.md" }] },
            ],
          }),
        ],
      }),
    );
    expect(presentContract(story.result, { ...summary, detail: "full" })).toContainEqual(
      Block.Table({
        columns: [
          { title: "Capability" },
          { title: "Harnesses" },
          { title: "Name" },
          { title: "Location" },
        ],
        rows: [
          [["Rule"], ["claude-code"], ["delegate.md"], ["/home/story/.claude/rules/delegate.md"]],
        ],
      }),
    );
  });
});
