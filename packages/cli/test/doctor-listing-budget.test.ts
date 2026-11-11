import { expect, test } from "vitest";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { ListingBudget, ListingReadFailure } from "@smolai/skit-core/harnesses/listing-contracts";
import { listingUnavailable } from "../src/library/doctor/listing-failures.js";
import { outputStories } from "../src/storybook/output-stories.js";
import { renderResultFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";
import { renderBlocks } from "../src/terminal/blocks.js";
import {
  renderDoctorListingBudget,
  renderDoctorBudgetSelection,
} from "../src/library/doctor/budget.js";
import { Block } from "../src/terminal/blocks.js";

const budget: Extract<ListingBudget, { _tag: "Estimated" }> = {
  _tag: "Estimated",
  harness: "codex",
  cwd: "/project",
  model: "model",
  unit: "budget-tokens",
  limit: 10000,
  demand: 3000,
  fitted: 3000,
  shortened: 0,
  omitted: 0,
  descriptionsDropped: { min: 0, max: 0 },
  fidelity: "modelled",
  entries: [
    { name: "exact-cutoff", path: "/exact", demand: 100 },
    { name: "large", path: "/large", demand: 101 },
  ],
  collections: [],
  provenance: {
    _tag: "CodexAllocation",
    contextWindow: 1000000,
    maxContextTokens: 10000,
    fraction: 0.01,
    fallbackCharacters: 8000,
    tokenCap: 10000,
  },
  skippedPaths: [],
  diagnostics: [],
};
const large = (path?: string) =>
  Block.Group({
    title: "Skills over 1% of budget, before trimming",
    children: [
      Block.Table({
        columns: [
          { title: "Skill" },
          { title: "Tokens", align: "end" },
          { title: "Share", align: "end" },
          ...(path === undefined ? [] : [{ title: "Path" }]),
        ],
        rows: [
          [
            [{ emph: "large" }],
            ["~101"],
            ["1.0%"],
            ...(path === undefined ? [] : [[{ dim: path }]]),
          ],
        ],
      }),
    ],
  });

test("doctor prints full demand and strict >1% contributors whether within or outside budget", () => {
  expect(renderDoctorListingBudget(budget, "summary")).toEqual(
    Block.Group({
      title: "Codex",
      children: [
        Block.Status({ tone: "ok", text: ["Within budget: ~3,000 / 10,000 tokens (30.0%)"] }),
        large(),
      ],
    }),
  );
  expect(
    renderDoctorListingBudget(
      { ...budget, demand: 12000, fitted: 10000, shortened: 3, omitted: 1 },
      "summary",
    ),
  ).toEqual(
    Block.Group({
      title: "Codex",
      children: [
        Block.Status({ tone: "warn", text: ["Over budget: ~12,000 / 10,000 tokens (120.0%)"] }),
        Block.Status({ tone: "warn", text: ["3 descriptions shortened"] }),
        Block.Status({ tone: "warn", text: ["1 skill omitted"] }),
        large(),
      ],
    }),
  );
  expect(renderDoctorListingBudget(budget, "full")).toEqual(
    Block.Group({
      title: "Codex",
      children: [
        Block.Status({ tone: "ok", text: ["Within budget: ~3,000 / 10,000 tokens (30.0%)"] }),
        large("/large"),
        Block.List({
          items: [
            {
              text: [
                {
                  dim: "model | context 1,000,000; configured token budget 10,000, capped at 10,000.",
                },
              ],
            },
            {
              text: [
                {
                  dim: "Includes native discoverable built-ins and other enabled skills. Path aliases are estimated; full instructions loaded later are additional.",
                },
              ],
            },
          ],
        }),
      ],
    }),
  );
});

test("doctor uses named character units and drop bounds for Claude, and reports unavailable explicitly", () => {
  const claude = renderDoctorListingBudget(
    {
      ...budget,
      harness: "claude-code",
      unit: "characters",
      fidelity: "bounded",
      descriptionsDropped: { min: 2, max: 4 },
    },
    "summary",
  );
  expect(claude).toMatchObject({
    title: "Claude Code",
    children: [
      Block.Status({ tone: "ok", text: ["Within budget: ~3,000 / 10,000 characters (30.0%)"] }),
      Block.Status({ tone: "warn", text: ["2–4 descriptions at risk of being dropped"] }),
      { _tag: "Group", children: [{ columns: [{}, { title: "Characters" }, {}] }] },
    ],
  });
  const missing: ListingBudget = {
    _tag: "Unavailable",
    harness: "codex",
    cwd: "/project",
    reason: { _tag: "DescriptionMissing", name: "review", path: "/skills/review/SKILL.md" },
  };
  for (const detail of ["summary", "full"] as const)
    expect(renderDoctorListingBudget(missing, detail)).toEqual(
      Block.Group({
        title: "Codex",
        children: [
          Block.Status({ tone: "warn", text: ["Budget unavailable"] }),
          Block.Note({
            text: [
              {
                dim: "Codex did not provide a description for review at /skills/review/SKILL.md; its listing demand cannot be estimated.",
              },
            ],
          }),
        ],
      }),
    );
});

test("doctor keeps the estimate and shows rejected skill diagnostics in the summary", () => {
  expect(
    renderDoctorListingBudget(
      {
        ...budget,
        diagnostics: [
          { path: "/broken/SKILL.md", diagnostic: "missing YAML frontmatter delimited by ---" },
        ],
      },
      "summary",
    ),
  ).toEqual(
    Block.Group({
      title: "Codex",
      children: [
        Block.Status({ tone: "ok", text: ["Within budget: ~3,000 / 10,000 tokens (30.0%)"] }),
        Block.Status({
          tone: "warn",
          text: ["Skipped skill /broken/SKILL.md: missing YAML frontmatter delimited by ---"],
        }),
        large(),
      ],
    }),
  );
});

test("doctor shows paths that tell same-named heavy Skills apart", () => {
  const twins = renderDoctorListingBudget(
    {
      ...budget,
      entries: [
        { name: "review", path: "/a", demand: 200 },
        { name: "review", path: "/b", demand: 300 },
        { name: "solo", path: "/c", demand: 400 },
      ],
    },
    "summary",
  );
  expect(twins).toMatchObject({
    children: [
      {},
      {
        children: [
          {
            columns: [{}, {}, {}, { title: "Path" }],
            rows: expect.arrayContaining([
              [[{ emph: "review" }], ["~200"], ["2.0%"], [{ dim: "/a" }]],
              [[{ emph: "solo" }], ["~400"], ["4.0%"], []],
            ]),
          },
        ],
      },
    ],
  });
});

test("cleanup bars show demand after the selected savings in native units", () => {
  const over = { ...budget, demand: 12400 };
  const before = renderDoctorBudgetSelection([over], {}, 80);
  const after = renderDoctorBudgetSelection([over], { codex: 2650 }, 80);
  expect(before).toHaveLength(1);
  expect(before[0]).toContain("124% | ~12,400 / 10,000 tokens");
  expect(before[0]).toContain("▓");
  expect(after[0]).toContain("98% | ~9,750 / 10,000 tokens");
  expect(after[0]).not.toContain("▓");
  expect(
    renderDoctorBudgetSelection([{ ...over, harness: "claude-code", unit: "characters" }], {
      "claude-code": 2650,
    }).join("\n"),
  ).toContain("9,750 / 10,000 characters");
  expect(renderDoctorBudgetSelection([over], { codex: 20000 })[0]).toContain("0% | ~0");
});

it.effect(
  "unavailable budgets keep schema facts through JSON and render the same explanation",
  () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Schema.decodeUnknownEffect(Schema.Struct({ model: Schema.String }))({ model: 5 }),
      );
      const budget: ListingBudget = {
        _tag: "Unavailable",
        harness: "claude-code",
        cwd: "/work/review",
        reason: {
          _tag: "ListingReadFailed",
          failure: new ListingReadFailure({
            reason: { _tag: "ReadFailed", path: "/home/me/.claude/settings.json", failure },
          }),
        },
      };
      const wire = Schema.encodeSync(Schema.toCodecJson(ListingBudget))(budget);
      const restored = Schema.decodeUnknownSync(ListingBudget)(JSON.parse(JSON.stringify(wire)));
      if (restored._tag !== "Unavailable") return yield* Effect.die("Budget changed state");
      expect(listingUnavailable(restored.reason)).toBe(listingUnavailable(budget.reason));
      expect(listingUnavailable(restored.reason)).toContain("/home/me/.claude/settings.json");
      expect(listingUnavailable(restored.reason)).toContain("model");
      expect(listingUnavailable(restored.reason)).not.toContain("StoredSchemaFailure");
      expect(wire).not.toHaveProperty("detail");
    }),
);

test("doctor preserves the native inventory when only its budget config request fails", () => {
  const story = outputStories.find((story) => story.name === "codex-config-rejected");
  if (story?._tag !== "Result") throw new Error("Missing Codex config failure story");
  const environment = { ...defaultTerminalEnvironment, color: false, width: 160 };
  const data = JSON.parse(
    renderResultFrame(story.result, { ...environment, format: "json" }).stdout,
  ).data;
  expect(data.codex).toMatchObject({ status: "checked", instances: [] });
  expect(data.listing_budgets[0]).toMatchObject({
    _tag: "Unavailable",
    harness: "codex",
    reason: {
      _tag: "DiscoveryFailed",
      failure: {
        reason: {
          _tag: "RemoteError",
          method: "config/read",
          diagnostic: "not supported by this build",
        },
      },
    },
  });
  expect(data.listing_budgets[0].reason.failure.reason._tag).toBe("RemoteError");
  expect(data.listing_budgets[0]).not.toHaveProperty("detail");
});

test("full Claude provenance explains observed sources and estimation assumptions as list items", () => {
  const measured: Extract<ListingBudget, { _tag: "Estimated" }> = {
    ...budget,
    harness: "claude-code",
    model: "sonnet",
    unit: "characters",
    limit: 40000,
    provenance: {
      _tag: "ClaudeFilesystem",
      modelSource: { _tag: "SettingsFile", path: "/work/.claude/settings.json" },
      limitSource: {
        _tag: "ContextConversion",
        contextWindow: 1000000,
        source: "catalog",
        charactersPerToken: 4,
        fraction: 0.01,
        clientVersion: "2.1.284",
      },
      descriptionCap: 1536,
      overrideSources: 2,
      configuredFraction: { value: 0.01, path: "/work/.claude/settings.json" },
    },
    skippedPaths: ["/work/.claude/skills/removed"],
  };
  const full = renderDoctorListingBudget(measured, "full");
  const list = full._tag === "Group" ? full.children.at(-1) : undefined;
  expect(list?._tag).toBe("List");
  const text = renderBlocks([full], { color: false, width: 160 });
  expect(text).toContain("sonnet (/work/.claude/settings.json)");
  expect(text).toContain("context 1,000,000 × 4 characters/token × 0.01 (Claude Code 2.1.284)");
  expect(text).toContain("native merge semantics are unverified");
  expect(text).toContain("Skipped unavailable skill path: /work/.claude/skills/removed");
  expect(text).not.toContain("ClaudeFilesystem");
  expect(text).not.toContain("undefined");
});

test("the full provenance story estimates the native skill its report actually lists", () => {
  const story = outputStories.find((story) => story.name === "listing-budget-provenance");
  if (story?._tag !== "Result" || story.result.contract !== "doctor")
    throw new Error("Missing provenance story");
  const data = story.result.data;
  const estimate = data.listing_budgets[0];
  if (estimate?._tag !== "Estimated") throw new Error("Missing estimate");
  expect(estimate.entries.map((skill) => skill.path)).toEqual(
    data.codex.instances.map((skill) => skill.path),
  );
  expect(story.result.detail).toBe("full");
});
