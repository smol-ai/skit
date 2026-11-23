import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { presentLibrarySync, presentLibrarySyncPlan } from "../src/library/sync/present.js";
import { Block, renderBlocks } from "../src/terminal/blocks.js";
import { result } from "../src/commands/result.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/commands/output-frame.js";

const collection = {
  kind: "collection",
  subject_id: "collection-1",
  skills_added: [],
  skills_removed: [],
  skills_changed: [],
  evidence_only: false,
} as const;

describe("presentLibrarySyncPlan", () => {
  it("groups changes by side, nests Skill changes, and hides evidence-only Collections", () => {
    const blocks = presentLibrarySyncPlan({
      local: [
        {
          ...collection,
          action: "update",
          label: "Team",
          skills_added: ["review"],
          skills_removed: ["a", "b", "c", "d", "e", "f"],
        },
        { ...collection, action: "update", label: "Refetched", evidence_only: true },
      ],
      remote: [
        {
          ...collection,
          action: "remove",
          label: "Docs",
          source_kind: "registry",
          authority: "https://registry.example:8443",
          release_version: "1.2.0+original",
        },
        {
          ...collection,
          action: "add",
          label: "Docs",
          source_kind: "authored-workspace",
          authority: "http://localhost:8810",
          skills_added: ["write"],
        },
        {
          kind: "enabled",
          action: "update",
          items_added: [
            {
              kind: "skill",
              label: "review",
              collection_label: "Docs",
              source_kind: "authored-workspace",
              authority: "http://localhost:8810",
            },
          ],
          items_removed: [
            {
              kind: "skill",
              label: "review",
              collection_label: "Docs",
              source_kind: "registry",
              authority: "https://registry.example:8443",
              release_version: "1.2.0+original",
            },
          ],
        },
      ],
    });

    expect(blocks).toEqual([
      Block.Heading({ text: "Library sync plan" }),
      Block.Group({
        title: "This device",
        children: [
          Block.Changes({
            title: "Collections",
            items: [
              {
                action: "update",
                label: "Team",
                children: [
                  { action: "add", label: "review" },
                  { action: "remove", label: "6 Skills" },
                ],
              },
            ],
          }),
        ],
      }),
      Block.Group({
        title: "Remote Library",
        children: [
          Block.Changes({
            title: "Collections",
            items: [
              { action: "remove", label: "Docs", detail: "registry.example:8443, 1.2.0+original" },
              { action: "add", label: "Docs", detail: "Author workspace, localhost:8810, 1 Skill" },
            ],
          }),
          Block.Changes({
            title: "Enabled",
            items: [
              {
                action: "update",
                label: "Enabled Skills",
                children: [
                  {
                    action: "add",
                    label: "review",
                    detail: "Docs, Author workspace, localhost:8810",
                  },
                  {
                    action: "remove",
                    label: "review",
                    detail: "Docs, registry.example:8443, 1.2.0+original",
                  },
                ],
              },
            ],
          }),
        ],
      }),
      Block.Note({ text: ["Plan: 1 to add, 2 to update, 1 to remove."] }),
    ]);
  });
});

describe("presentLibrarySync", () => {
  it("states an unapplied plan's outcome after the plan and notes", () => {
    const blocks = presentLibrarySync({
      status: "pull_ready",
      merge_base: "empty-first-sync",
      plan: { local: [], remote: [] },
      author_workspaces: [
        {
          identity: "skit://registry.example/tim/tools",
          directory: "/work/tools",
          status: "sync",
          sync: { status: "up_to_date", changed: false, revision_id: "revision" },
        },
      ],
    });
    expect(blocks.map((block) => block._tag)).toEqual([
      "Heading",
      "List",
      "Heading",
      "Group",
      "Group",
      "Note",
      "Note",
      "Status",
    ]);
    expect(blocks[1]).toMatchObject({
      items: [
        {
          text: [
            "skit://registry.example/tim/tools",
            " at ",
            { code: "/work/tools" },
            " — ",
            "up to date",
          ],
        },
      ],
    });
    expect(blocks.at(-1)).toMatchObject({ _tag: "Status", tone: "info" });
  });

  it("asks for a fresh preview when conflicts have keys but no resolution facts", () => {
    const data = {
      status: "conflicted" as const,
      conflicts: ["skills/a", "skills/b"],
    };
    const blocks = presentLibrarySync(data);
    expect(blocks[0]).toMatchObject({ _tag: "Status", tone: "error" });
    const text = renderBlocks(blocks, { color: false });
    expect(text).toContain("no named conflict details or confirmed resolution choices");
    expect(text).toContain("Preview the current conflicts with skit sync");
    expect(text).not.toContain("--take-remote");
    expect(text).not.toContain("skills/a");
    const json = renderResultFrame(result("librarySync", data), {
      ...defaultTerminalEnvironment,
      format: "json",
    });
    expect(JSON.parse(json.stdout).data.conflicts).toEqual(data.conflicts);
  });
});

describe("renderBlocks", () => {
  const blocks = [
    Block.Heading({ text: "Title\u001b]52;c;cGFzdGU=\u0007" }),
    Block.Status({ tone: "ok", text: ["done ", { code: "skit\u001b[2J sync" }] }),
  ];

  it("removes terminal controls from presenter text", () => {
    const plain = renderBlocks(blocks, { color: false });
    expect(plain).not.toContain("\u001b");
    expect(plain).not.toContain("\u0007");
    // Colour only adds styling around the same text.
    expect(stripVTControlCharacters(renderBlocks(blocks, { color: true }))).toBe(plain);
  });
});
