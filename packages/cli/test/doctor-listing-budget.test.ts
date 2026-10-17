import { expect, test } from "vitest";
import type { ListingBudget } from "@smolai/skit-core";
import {
  renderDoctorListingBudget,
  renderDoctorBudgetSelection,
} from "../src/presentation/doctor-listing-budget.js";

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
  basis: "catalog model provenance",
  coverage: ["discovery coverage note"],
};
const render = (value: ListingBudget, detail: "summary" | "full" = "summary") =>
  renderDoctorListingBudget(value, { color: false, detail }).join("\n");

test("doctor prints full demand and strict >1% contributors whether within or outside budget", () => {
  const within = render(budget);
  expect(within).toContain("Within budget");
  expect(within).toContain("3,000 / 10,000 tokens · 30.0%");
  expect(within).toContain("large · ~101 tokens");
  expect(within).not.toContain("exact-cutoff");
  expect(within).not.toContain("provenance");
  expect(within).not.toContain("coverage note");
  const outside = render({ ...budget, demand: 12000, fitted: 10000, shortened: 3, omitted: 1 });
  expect(outside).toContain("Over budget");
  expect(outside).toContain("12,000 / 10,000");
  expect(outside).toContain("large · ~101");
  expect(outside).toContain("3 descriptions shortened");
  expect(outside).toContain("1 skill omitted");
  const full = render(budget, "full");
  expect(full).toContain("catalog model provenance");
  expect(full).toContain("discovery coverage note");
  expect(full).toContain("/large");
});

test("doctor uses named character units and drop bounds for Claude, and reports unavailable explicitly", () => {
  const claude = render({
    ...budget,
    harness: "claude-code",
    unit: "characters",
    fidelity: "bounded",
    descriptionsDropped: { min: 2, max: 4 },
  });
  expect(claude).toContain("Claude Code");
  expect(claude).toContain("3,000 / 10,000 characters");
  expect(claude).toContain("2–4 descriptions at risk");
  const missing: ListingBudget = {
    _tag: "Unavailable",
    harness: "codex",
    cwd: "/project",
    detail: "config unreadable",
  };
  expect(render(missing)).toContain("budget unavailable");
  expect(render(missing)).not.toContain("Within budget");
  expect(render(missing)).toContain("config unreadable");
  expect(render(missing, "full")).toContain("config unreadable");
});

test("doctor keeps the estimate and shows rejected skill diagnostics in the summary", () => {
  const output = render({
    ...budget,
    warnings: ["Skipped skill /broken/SKILL.md: missing YAML frontmatter delimited by ---"],
  });
  expect(output).toContain("Within budget");
  expect(output).toContain("3,000 / 10,000 tokens");
  expect(output).toContain(
    "Skipped skill /broken/SKILL.md: missing YAML frontmatter delimited by ---",
  );
});

test("cleanup bars keep the limit fixed and show the selected savings in native units", () => {
  const over = { ...budget, demand: 12400 };
  const before = renderDoctorBudgetSelection([over], {}, 80);
  const after = renderDoctorBudgetSelection([over], { codex: 2650 }, 80);
  expect(before[0]).toContain("124%");
  expect(before[1]).toContain("~12,400 / 10,000 tokens");
  expect(after[1]).toContain("98% · ~9,750 / 10,000 tokens");
  expect(after[0]).toBe(before[0]);
  expect(after[0].indexOf("│")).toBe(after[1].indexOf("│"));
  expect(after[1].split("█").length).toBeLessThan(after[0].split("█").length);
  expect(
    renderDoctorBudgetSelection([{ ...over, harness: "claude-code", unit: "characters" }], {
      "claude-code": 2650,
    }).join("\n"),
  ).toContain("9,750 / 10,000 characters");
  expect(renderDoctorBudgetSelection([over], { codex: 20000 })[1]).toContain("0% · ~0");
});
