import { expect, test } from "vitest";
import { Cause, Schema } from "effect";
import { LibraryChanged, ContentAddressCollision } from "@smolai/skit-core/library";
import { StepSchemaFailure } from "@smolai/skit-core/library/recorded-failures";
import { DedicatedInstallerRequired } from "@smolai/skit-core/library/source/installer";
import { CommandFailed } from "@smolai/skit-core/library/source/failures";
import {
  SourcePolicyViolation,
  SourceProcessTimedOut,
} from "@smolai/skit-core/library/source/failures";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { classifyFailure, commandFailure } from "../src/commands/failure-classification.js";
import { describeFailure } from "../src/terminal/failure.js";
import { Block, renderBlocks } from "../src/terminal/blocks.js";
import { MissingRequirement, OptionCombinationInvalid } from "../src/commands/input-failures.js";
import { NothingToSelect, SelectionCancelled } from "../src/terminal/interaction-failures.js";
import { PromptCancelled } from "../src/terminal/prompter.js";
import { CommandLineInvalid } from "../src/commands/input-failures.js";
import { CliError } from "effect/cli";

test("parser issues remain ordered native errors and become separate list items", () => {
  const first = new CliError.MissingArgument({ argument: "skill" });
  const second = new CliError.MissingOption({ option: "--version" });
  const input = new CommandLineInvalid({ errors: [first, second] });
  expect(input.errors[0]).toBe(first);
  expect(input.errors[1]).toBe(second);
  const failure = classifyFailure(input);
  expect(failure.code).toBe("INVALID_ARGUMENT");
  expect(failure.presentation).toEqual([
    Block.Status({ tone: "error", text: ["Command line is invalid"] }),
    Block.List({ items: [{ text: [first.message] }, { text: [second.message] }] }),
    Block.Fields({
      rows: [
        { label: "Next", value: ["Run ", { code: "skit --help" }, " to review command usage."] },
      ],
    }),
  ]);
});

test.each(["back", "interrupt"] as const)(
  "a prompt %s retains the typed action and semantic help span",
  (reason) => {
    const input = new PromptCancelled({ prompt: "Choose Skills", reason });
    const failure = classifyFailure(input);
    expect(input.reason).toBe(reason);
    expect(failure.code).toBe("OPERATION_FAILED");
    expect(failure.presentation).toEqual([
      Block.Status({ tone: "error", text: ["Choose Skills", " cancelled"] }),
      Block.Fields({
        rows: [
          {
            label: "Next",
            value: [
              "Run the command again to make a choice, or pass it as a flag to skip the prompt; ",
              { code: "--help" },
              " lists them.",
            ],
          },
        ],
      }),
    ]);
  },
);

test("missing input keeps the command and required value as semantic spans", () => {
  const failure = classifyFailure(
    new MissingRequirement({ reason: { _tag: "InstalledEditSubject" } }),
  );
  expect(failure.code).toBe("INVALID_ARGUMENT");
  expect(failure.presentation).toEqual([
    Block.Status({
      tone: "error",
      text: [
        "Using ",
        { code: "--from" },
        " with ",
        { code: "skit update" },
        " requires ",
        { code: "<skill>" },
      ],
    }),
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: [
            "Pass ",
            { code: "<skill>" },
            ", then retry. ",
            { code: "skit list --json" },
            " lists the Library's Skills.",
          ],
        },
      ],
    }),
  ]);
});

test("invalid option combinations retain the actual flags as semantic spans", () => {
  const failure = classifyFailure(
    new OptionCombinationInvalid({
      reason: { _tag: "ConflictingOptions", options: ["--global", "--repo"] },
    }),
  );
  expect(failure.explanation).toEqual([
    Block.Status({ tone: "error", text: ["These options cannot be used together"] }),
    Block.List({ items: [{ text: [{ code: "--global" }] }, { text: [{ code: "--repo" }] }] }),
  ]);
  expect(failure.next).toEqual(["Choose one of the listed options, then retry."]);
});

test("selection failures choose applicable actions without flattening their commands", () => {
  expect(classifyFailure(new SelectionCancelled({ subject: "Login" })).presentation).toEqual([
    Block.Status({ tone: "error", text: ["Login cancelled"] }),
    Block.Fields({
      rows: [{ label: "Next", value: ["Run ", { code: "skit auth login" }, " again when ready."] }],
    }),
  ]);
  expect(classifyFailure(new SelectionCancelled({ subject: "Skill" })).presentation.at(-1)).toEqual(
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: ["Run the command again and make a selection, or pass the choice as an argument."],
        },
      ],
    }),
  );
  const empty = classifyFailure(new NothingToSelect({ reason: { _tag: "LibrarySkills" } }));
  expect(empty.code).toBe("NOT_FOUND");
  expect(empty.presentation.at(-1)).toEqual(
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: ["Run ", { code: "skit add <source>" }, " to add Skills, then try again."],
        },
      ],
    }),
  );
});

test("the semantic description owns summary, details and next-step spans", () => {
  const detail = Block.List({ items: [{ text: ["review"], detail: ["Its files changed."] }] });
  const described = describeFailure({
    summary: ["Cannot update ", { code: "/skills/review" }],
    details: [detail],
    next: ["Run ", { code: "skit doctor" }, "."],
  });
  expect(described.presentation).toEqual([
    Block.Status({ tone: "error", text: ["Cannot update ", { code: "/skills/review" }] }),
    detail,
    Block.Fields({ rows: [{ label: "Next", value: ["Run ", { code: "skit doctor" }, "."] }] }),
  ]);
  expect(described.message).toBe("Cannot update /skills/review\n  review\n    Its files changed.");
  expect(described.remediation).toBe("Run `skit doctor`.");
});

test("an installer command containing literal backticks stays one code span", () => {
  const command = "npx tool --name '`literal`'";
  const failure = classifyFailure(
    new DedicatedInstallerRequired({
      displayName: "Tool",
      sourceCoordinate: "github:example/tool",
      command,
      documentationUrl: "https://example.test/install",
    }),
  );
  expect(failure.presentation.at(-1)).toEqual(
    Block.Fields({
      rows: [
        {
          label: "Next",
          value: [
            "Run ",
            { code: command },
            ". Installation guide: ",
            { url: "https://example.test/install" },
          ],
        },
      ],
    }),
  );
});

test("stored schema facts become ordered list items instead of indented message lines", () => {
  const failure = classifyFailure(
    new StepSchemaFailure({
      failure: {
        _tag: "StoredSchemaFailure",
        issues: [
          { path: ["enabled"], reason: { _tag: "InvalidType", expected: [{ type: "Boolean" }] } },
          { path: ["skills", 0], reason: { _tag: "MissingKey" } },
        ],
      },
    }),
  );
  expect(failure.presentation[1]).toEqual(
    Block.List({
      items: [
        { text: ['Expected boolean at ["enabled"]'] },
        { text: ['Missing required field at ["skills"][0]'] },
      ],
    }),
  );
  expect(failure.presentation.some((block) => block._tag === "Verbatim")).toBe(false);
});

test("secondary causes keep their own semantic failure and next step", () => {
  const secondary = new LibraryChanged({ path: "/state.json" });
  const failure = commandFailure(
    Cause.combine(Cause.fail(new ContentAddressCollision()), Cause.fail(secondary)),
  );
  expect(failure.presentation.at(-1)).toEqual(
    Block.Group({ title: "Additional failure", children: classifyFailure(secondary).presentation }),
  );
  expect(failure.code).toBe("CONFLICT");
});

test("verbatim details belong to a subprocess's actual output", () => {
  const stderr = "fatal: source unavailable\n  external diagnostic";
  const failure = classifyFailure(
    new CommandFailed({ command: "git fetch", exitCode: 128, stderr }),
  );
  expect(failure.presentation[0]).toEqual(
    Block.Status({ tone: "error", text: [{ code: "git fetch" }, " failed (exit 128)"] }),
  );
  expect(failure.presentation[1]).toEqual(Block.Verbatim({ text: stderr }));
});

test("source restoration retains nested Git command spans, output bytes and next steps after the codec", () => {
  const command = new CommandFailed({
    command: "git show expected:SKILL.md",
    exitCode: 128,
    stderr: "fatal: unknown revision\n  external detail",
  });
  const policy = new SourcePolicyViolation({
    reason: {
      _tag: "GitRevisionUnavailable",
      revision: "expected",
      remote: "https://git.test/review",
      failure: command,
    },
  });
  const restore = new SourceRestoreInvalid({
    hash: "sha256:expected",
    reason: { _tag: "SourceFetchFailed", failure: policy },
  });
  expect(restore.reason._tag === "SourceFetchFailed" && restore.reason.failure).toBe(policy);
  const wire = Schema.encodeSync(SourceRestoreInvalid)(restore);
  expect(wire).not.toHaveProperty("message");
  const decoded = Schema.decodeUnknownSync(SourceRestoreInvalid)(JSON.parse(JSON.stringify(wire)));
  const formatted = classifyFailure(decoded);
  const nested = classifyFailure(policy);
  expect(formatted.presentation).toContainEqual(
    Block.Group({ title: "Source failed", children: nested.explanation }),
  );
  expect(nested.presentation).toContainEqual(
    Block.Group({ title: "Command failed", children: classifyFailure(command).explanation }),
  );
  expect(classifyFailure(command).presentation).toContainEqual(
    Block.Verbatim({ text: command.stderr }),
  );
  expect(formatted.message).toContain("external detail");
  expect(formatted.next).toEqual(nested.next);
  const rendered = renderBlocks(formatted.presentation, { color: false });
  expect(rendered.match(/Next/g)).toHaveLength(1);
});

test("source process policy retains the typed process failure's own action", () => {
  const timedOut = new SourceProcessTimedOut({ invocation: "git fetch", timeoutMs: 5000 });
  const formatted = classifyFailure(
    new SourcePolicyViolation({ reason: { _tag: "ProcessFailed", failure: timedOut } }),
  );
  expect(formatted.presentation).toEqual(classifyFailure(timedOut).presentation);
  expect(formatted.remediation).toBe(classifyFailure(timedOut).remediation);
});

test("discovery schema diagnostics remain individual items inside source restoration", () => {
  const policy = new SourcePolicyViolation({
    reason: {
      _tag: "DiscoveryIndexInvalid",
      url: "https://source.test/index.json",
      failure: {
        _tag: "StoredSchemaFailure",
        issues: [
          { path: ["skills"], reason: { _tag: "MissingKey" } },
          { path: ["version"], reason: { _tag: "InvalidType", expected: [{ type: "String" }] } },
        ],
      },
    },
  });
  const formatted = classifyFailure(policy);
  expect(formatted.presentation).toContainEqual(
    Block.List({
      items: [
        { text: ['Missing required field at ["skills"]'] },
        { text: ['Expected string at ["version"]'] },
      ],
    }),
  );
  const restore = classifyFailure(
    new SourceRestoreInvalid({
      hash: "sha256:expected",
      reason: { _tag: "SourceFetchFailed", failure: policy },
    }),
  );
  expect(restore.presentation).toContainEqual(
    Block.Group({ title: "Source failed", children: formatted.explanation }),
  );
});

test("an unknown source restoration failure keeps honest diagnostics and an action", () => {
  const formatted = classifyFailure(
    new SourceRestoreInvalid({
      hash: "sha256:expected",
      reason: { _tag: "SourceFetchFailed", failure: new Error("Source reader failed") },
    }),
  );
  expect(formatted.presentation).toContainEqual(
    Block.Group({
      title: "Source failed",
      children: [Block.Status({ tone: "error", text: ["Source reader failed"] })],
    }),
  );
  expect(formatted.next).toContainEqual({ code: "skit update" });
});

test.each([40, 100])(
  "semantic failure prose wraps at width %i and sanitizes every span",
  (width) => {
    const failure = describeFailure({
      summary: ["Could not apply the reviewed Library changes safely"],
      details: [
        Block.List({
          items: [
            {
              text: ["review"],
              detail: [
                "The files changed after review and need a fresh decision before SKIT can continue.",
              ],
            },
          ],
        }),
      ],
      next: [
        "Run ",
        { code: "skit doctor\u001b[31m" },
        " to review the current installed copies before trying again.",
      ],
    });
    const shown = renderBlocks(failure.presentation, { color: false, width });
    expect(shown.split("\n").every((line) => line.length <= width)).toBe(true);
    expect(shown).not.toContain("\u001b");
  },
);
