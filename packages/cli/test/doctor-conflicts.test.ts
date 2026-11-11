import { result } from "../src/commands/result.js";
import { HarnessDiscoveryFailed } from "@smolai/skit-core/harnesses/discovery-failures";
import { presentContract } from "../src/commands/output-presenters.js";
import { conditionNextStep } from "../src/library/presentation/language.js";
import { expect, test } from "vitest";
import { outputStories } from "../src/storybook/output-stories.js";
import { renderResultFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";

const cases = [
  [
    "installed-files-edited",
    "The installed files differ from the content recorded in the ownership marker.",
  ],
  ["ownership-marker-missing", "The installed folder has no SKIT ownership marker."],
  ["ownership-marker-invalid", "The ownership marker is not valid JSON."],
  ["ownership-marker-not-object", "The ownership marker must contain a JSON object."],
  [
    "ownership-marker-invalid-fields",
    "The ownership marker's fields do not match a supported SKIT format.",
  ],
  ["ownership-skill-mismatch", "The ownership marker names a different skill"],
  ["ownership-copy-mismatch", "The ownership marker belongs to a different installed copy."],
  [
    "ownership-hash-mismatch",
    "The ownership marker's content hash differs from the Library's record.",
  ],
];

test.each(cases)("doctor explains %s without unrelated Harness failures", (name, explanation) => {
  const story = outputStories.find((story) => story.group === "doctor" && story.name === name);
  if (story?._tag !== "Result") throw new Error(`Missing doctor story: ${name}`);
  expect(story.scenario).toEqual({
    initial: expect.any(String),
    trigger: expect.any(String),
    result: expect.any(String),
  });
  const environment = { ...defaultTerminalEnvironment, width: 160, color: false };
  const frame = renderResultFrame(story.result, environment);
  expect(presentContract(story.result, environment)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        _tag: "Group",
        title: "Needs attention",
        children: expect.arrayContaining([
          expect.objectContaining({
            _tag: "List",
            items: expect.arrayContaining([
              expect.objectContaining({ text: [expect.stringContaining(explanation)] }),
            ]),
          }),
        ]),
      }),
    ]),
  );
  expect(frame.exitCode).toBe(1);
  const json = renderResultFrame(story.result, { ...environment, format: "json" });
  const data = JSON.parse(json.stdout).data;
  expect(data.issues[0].conflicts.length).toBeGreaterThan(0);
  expect(data.harnesses).toEqual([]);
  expect(data.codex.errors).toEqual([]);
});

test("doctor asks for fresh evidence when an older record has no conflict reason", () => {
  expect(conditionNextStep("PROJECTION_CONFLICT", [])).toBe(
    "Run `skit inventory`, then `skit doctor` to check the folder again.",
  );
});

test.each([
  [
    "discovery-wrong-directory",
    "OpenCode returned inventory for /home/story/work/other; doctor requested /home/story/work/review-tools.",
    "DirectoryMismatch",
  ],
  ["discovery-http-failure", "OpenCode /api/plugin returned HTTP 500.", "HttpStatus"],
])(
  "doctor renders %s and keeps the native failure facts in JSON",
  (name, explanation, reasonTag) => {
    const story = outputStories.find((story) => story.group === "doctor" && story.name === name);
    if (story?._tag !== "Result") throw new Error(`Missing doctor story: ${name}`);
    const environment = { ...defaultTerminalEnvironment, width: 160, color: false };
    expect(presentContract(story.result, environment)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Group",
          title: "Harness discovery",
          children: expect.arrayContaining([
            expect.objectContaining({
              _tag: "List",
              items: [{ text: [{ dim: expect.stringContaining(explanation) }] }],
            }),
          ]),
        }),
      ]),
    );
    const json = JSON.parse(
      renderResultFrame(story.result, { ...environment, format: "json" }).stdout,
    );
    expect(json.data.harnesses[0].discoveryFailure.reason._tag).toBe(reasonTag);
    expect(json.data.harnesses[0]).not.toHaveProperty("detail");
  },
);

test("custom roots remain facts and the CLI names the applicable flags", () => {
  const story = outputStories.find((story) => story.name === "custom-roots");
  if (story?._tag !== "Result") throw new Error("Missing custom roots story");
  const environment = { ...defaultTerminalEnvironment, color: false, width: 160 };
  const blocks = presentContract(story.result, environment);
  for (const flag of ["--codex-root", "--claude-root"])
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _tag: "Group",
          title: "Harness discovery",
          children: expect.arrayContaining([
            expect.objectContaining({
              _tag: "List",
              items: [{ text: [{ dim: expect.stringContaining(`without ${flag}`) }] }],
            }),
          ]),
        }),
      ]),
    );
  const data = JSON.parse(
    renderResultFrame(story.result, { ...environment, format: "json" }).stdout,
  ).data;
  expect(data.codex.rootOverrides).toEqual(["/home/story/custom/codex"]);
  expect(data.harnesses[0].rootOverrides).toEqual(["/home/story/custom/claude"]);
  for (const check of [data.codex, ...data.harnesses]) {
    expect(check).not.toHaveProperty("protocol");
    expect(check).not.toHaveProperty("detail");
    expect(check).not.toHaveProperty("limitations");
  }
});

test("full detail explains a successful discovery protocol without claiming a failed inventory was checked", () => {
  const environment = {
    ...defaultTerminalEnvironment,
    color: false,
    width: 160,
    detail: "full" as const,
  };
  for (const status of ["checked", "failed"] as const) {
    const report = result("doctor", {
      ok: true,
      issues: [],
      listing_budgets: [],
      codex: { status: "checked", cwd: "/work", instances: [], findings: [], errors: [] },
      harnesses: [
        {
          harness: "opencode",
          status,
          cwd: "/work",
          protocol: "opencode-http-v2",
          coverage: "resolved-skills",
          skills: [],
          findings: [],
          warnings: [],
          ...(status === "failed"
            ? {
                discoveryFailure: new HarnessDiscoveryFailed({
                  harness: "opencode",
                  cwd: "/work",
                  reason: { _tag: "HttpStatus", endpoint: "/api/plugin", status: 500 },
                }),
              }
            : {}),
        },
      ],
    });
    const blocks = presentContract(report, environment);
    const discovery = blocks.find(
      (block) => block._tag === "Group" && block.title === "Harness discovery",
    );
    if (discovery?._tag !== "Group") throw new Error("Missing discovery group");
    const limitations = expect.arrayContaining([
      expect.objectContaining({
        _tag: "List",
        items: [{ text: [{ dim: expect.stringContaining("three stable metadata snapshots") }] }],
      }),
    ]);
    if (status === "checked") expect(discovery.children).toEqual(limitations);
    else {
      expect(discovery.children).not.toEqual(limitations);
      expect(discovery.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _tag: "List",
            items: [
              {
                text: [{ dim: expect.stringContaining("OpenCode /api/plugin returned HTTP 500") }],
              },
            ],
          }),
        ]),
      );
    }
    const data = JSON.parse(
      renderResultFrame(report, { ...environment, format: "json" }).stdout,
    ).data;
    expect(data.harnesses[0].protocol).toBe("opencode-http-v2");
    expect(data.harnesses[0]).not.toHaveProperty("limitations");
  }
});
