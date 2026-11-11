import { execFileSync } from "node:child_process";
import { AuthorSyncRequired } from "../src/registry/failures.js";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { Block, renderBlocks } from "../src/terminal/blocks.js";
import stringWidth from "string-width";

const lines = (blocks: Block[], width?: number) =>
  stripVTControlCharacters(
    renderBlocks(blocks, { color: true, ...(width === undefined ? {} : { width }) }),
  ).split("\n");

const words = (text: string) => text.split(/\s+/).filter(Boolean);

const prose =
  "cli-ux changed on this device and on the remote Library since they last synced, so neither copy can replace the other without losing an edit.";

describe("renderBlocks", () => {
  it("keeps URL targets exact across home abbreviation, wrapping and terminal sanitisation", () => {
    const url = "https://example.com/home/story/guide?view=full#install";
    for (const color of [true, false]) {
      const shown = stripVTControlCharacters(
        renderBlocks([Block.Note({ text: ["Guide: ", { url: `${url}\u0007` }] })], {
          color,
          width: 40,
          home: "/home/story",
        }),
      );
      expect(shown).toBe(`Guide:\n${url}`);
    }
  });

  it("wraps oversized paths under their Field value without splitting Unicode graphemes", () => {
    const path = `/work/${"界e\u0301👩‍💻".repeat(12)}/SKILL.md`;
    const drawn = lines(
      [Block.Fields({ rows: [{ label: "Installed at", value: [{ path }] }] })],
      40,
    );
    const start = 14;
    expect(drawn.every((line) => stringWidth(line) <= 40)).toBe(true);
    expect(drawn.slice(1).every((line) => line.startsWith(" ".repeat(start)))).toBe(true);
    const chunks = drawn.map((line) => line.slice(start));
    expect(chunks.join("")).toBe(path);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\p{Mark}/u);
      expect(chunk.startsWith("\u200d") || chunk.endsWith("\u200d")).toBe(false);
    }
  });

  it("aligns Field labels by terminal cells rather than UTF-16 length", () => {
    const drawn = lines(
      [
        Block.Fields({
          rows: [
            { label: "場所", value: ["one"] },
            { label: "Path", value: ["two"] },
          ],
        }),
      ],
      40,
    );
    expect(stringWidth(drawn[0]!.slice(0, drawn[0]!.indexOf("one")))).toBe(6);
    expect(stringWidth(drawn[1]!.slice(0, drawn[1]!.indexOf("two")))).toBe(6);
  });

  it("keeps copied code tokens exact even when they exceed the available width", () => {
    const token = `/work/${"long-folder-".repeat(12)}/SKILL.md`;
    expect(lines([Block.Note({ text: [{ code: token }] })], 40)).toEqual([token]);
  });

  it("wraps long paths in the narrow Table fallback under the labeled value", () => {
    const path = `/work/${"review-tools/".repeat(8)}SKILL.md`;
    const drawn = lines(
      [
        Block.Group({
          title: "Global",
          children: [
            Block.Table({
              columns: [{ title: "Skill" }, { title: "Path" }],
              rows: [[["review"], [{ path }]]],
            }),
          ],
        }),
      ],
      40,
    );
    expect(drawn.every((line) => stringWidth(line) <= 40)).toBe(true);
    const start = drawn.findIndex((line) => line.startsWith("  Path: "));
    expect(start).toBeGreaterThan(0);
    const values = drawn.slice(start);
    expect(values.slice(1).every((line) => line.startsWith("        "))).toBe(true);
    expect(values.map((line) => line.slice(8)).join("")).toBe(path);
  });

  it("wraps prose at spaces within the width and continues under where the text began", () => {
    const drawn = lines(
      [Block.Status({ tone: "warn", text: [prose.slice(0, 40), { code: prose.slice(40) }] })],
      40,
    );
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.every((line) => line.length <= 40)).toBe(true);
    // Nothing is lost or split: the words read the same once the glyph is set aside.
    expect(words(drawn.join(" ")).slice(1)).toEqual(words(prose));
    const start = drawn[0]!.indexOf(drawn[0]!.trim().split(" ")[1]!);
    expect(drawn.slice(1).every((line) => line.search(/\S/) === start)).toBe(true);
  });

  it("keeps Verbatim text exactly as given, whatever the width", () => {
    const script = `complete -W "${prose}" skit\n\n_skit() {\n\tlocal cur\n}`;
    expect(lines([Block.Verbatim({ text: script })], 40).join("\n")).toBe(script);
  });

  it("leaves prose on one line when there is no terminal width", () => {
    expect(lines([Block.Note({ text: [prose] })])).toHaveLength(1);
  });

  it("keeps a run of Status lines together and sets other Blocks apart", () => {
    const drawn = lines([
      Block.Status({ tone: "ok", text: ["one"] }),
      Block.Status({ tone: "warn", text: ["two"] }),
      Block.Note({ text: ["three"] }),
    ]);
    expect(drawn.map((line) => line === "")).toEqual([false, false, true, false]);
  });

  it("starts every Field value in the same column, also when it wraps", () => {
    const drawn = lines(
      [
        Block.Fields({
          rows: [
            { label: "Skill", value: ["cli-ux"] },
            { label: "Installed at", value: [prose] },
          ],
        }),
      ],
      60,
    );
    const column = drawn[0]!.indexOf("cli-ux");
    expect(drawn.length).toBeGreaterThan(2);
    expect(drawn[1]!.indexOf(words(prose)[0]!)).toBe(column);
    expect(drawn.slice(2).every((line) => line.search(/\S/) === column)).toBe(true);
  });

  it("aligns Table columns, numbers to the end", () => {
    const drawn = lines([
      Block.Table({
        columns: [{ title: "Skill" }, { title: "Tokens", align: "end" }],
        rows: [
          [["cli-ux"], ["860"]],
          [["nvidia-skill-finder"], ["12,000"]],
        ],
      }),
    ]);
    expect(new Set(drawn.map((line) => line.length)).size).toBe(1);
    expect(drawn[1]!.indexOf("860") + 3).toBe(drawn[2]!.indexOf("12,000") + 6);
  });

  it("keeps multiline cells attached to their row and column, including in redirected output", () => {
    const table = Block.Table({
      columns: [{ title: "Skill" }, { title: "Paths" }],
      rows: [
        [["review"], [{ path: "skills/review\narchived/review" }]],
        [["docs"], [{ path: "skills/docs" }]],
      ],
    });
    for (const width of [undefined, 40, 100]) {
      expect(lines([table], width)).toEqual([
        "Skill: review",
        "Paths: skills/review",
        "       archived/review",
        "",
        "Skill: docs",
        "Paths: skills/docs",
      ]);
    }
  });
});

it("keeps every Table fact readable when its columns do not fit", () => {
  const table = Block.Table({
    columns: [{ title: "Skill" }, { title: "Agents" }, { title: "Tokens", align: "end" }],
    rows: [[["nvidia-skill-finder"], ["Codex, Claude Code"], ["12,000"]]],
  });
  const narrow = lines([table], 40);
  expect(narrow).toEqual([
    "Skill: nvidia-skill-finder",
    "Agents: Codex, Claude Code",
    "Tokens: 12,000",
  ]);
  expect(narrow.every((line) => line.length <= 40)).toBe(true);
  const wide = lines([table], 100);
  expect(wide).toHaveLength(2);
  expect(wide[1]).toContain("nvidia-skill-finder");
  expect(wide[1]).toContain("Codex, Claude Code");
  expect(wide[1]).toContain("12,000");
});

it("home abbreviation keeps a quoted command copyable by a shell", () => {
  const home = "/home/story";
  const root = `${home}/work/review tools`;
  const command = `skit author sync '${root}' --apply`;
  const failure = classifyFailure(new AuthorSyncRequired({ root }));
  const shown = renderBlocks(failure.presentation, { color: false, home });
  expect(shown).toContain(command);
  expect(shown).not.toContain("'~/");
  // Parse the displayed command as a shell would, replacing SKIT with an argv recorder.
  const argv = execFileSync("/bin/sh", ["-c", `skit() { printf '%s\\n' "$@"; }\n${command}`], {
    encoding: "utf8",
  });
  expect(argv.trimEnd().split("\n")).toEqual(["author", "sync", root, "--apply"]);
});

it("path spans abbreviate home while code and external output remain exact", () => {
  const home = "/home/story";
  const command = `cat '${home}/work/review tools/SKILL.md'`;
  const shown = renderBlocks(
    [
      Block.Fields({
        rows: [
          { label: "Path", value: [{ path: `${home}/work/review tools` }] },
          { label: "Command", value: [{ code: command }] },
        ],
      }),
      Block.Verbatim({ text: `external: ${home}/work/review tools` }),
    ],
    { color: false, home },
  );
  expect(shown).toContain("~/work/review tools");
  expect(shown).toContain(command);
  expect(shown).toContain(`external: ${home}/work/review tools`);
});

it("keeps styled words and punctuation together at the wrapping edge", () => {
  expect(lines([Block.Note({ text: ["Run ", { code: "skit sync --apply" }, "."] })], 20)).toEqual([
    "Run skit sync",
    "--apply.",
  ]);
  expect(lines([Block.Note({ text: ["Use ", { emph: "some" }, "thing now"] })], 10)).toEqual([
    "Use",
    "something",
    "now",
  ]);
  expect(lines([Block.Note({ text: ["label", { dim: " (detail)" }] })])).toEqual([
    "label (detail)",
  ]);
});

it("preserves indentation after explicit newlines, including across styles", () => {
  expect(lines([Block.Note({ text: ["first\n  ", { emph: "indented" }, " line"] })], 40)).toEqual([
    "first",
    "  indented line",
  ]);
});
