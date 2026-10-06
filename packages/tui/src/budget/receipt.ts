import { fg, StyledText } from "@opentui/core";
import { ink, tone } from "../theme";
import type { ListingBudget } from "./contracts";

const amount = (value: number) => value.toLocaleString("en-US");

export function budgetReceipt(budget: ListingBudget): StyledText {
  if (budget._tag === "Unavailable")
    return new StyledText([fg(tone.warning)("Unavailable\n"), fg(ink.muted)(budget.detail)]);
  const unit = budget.unit === "characters" ? "characters" : "budget tokens";
  if (budget._tag === "DemandOnly")
    return new StyledText([
      fg(ink.strong)(`~${amount(budget.demand)} `),
      fg(ink.muted)(`${unit} · limit unknown`),
    ]);
  const outside = budget.demand > budget.limit;
  return new StyledText([
    fg(outside ? tone.warning : tone.success)(outside ? "⚠ Over budget" : "✓ Within budget"),
    fg(ink.muted)(" · "),
    fg(ink.strong)(`${((budget.demand / budget.limit) * 100).toFixed(1)}% used\n`),
    fg(ink.DEFAULT)(`~${amount(budget.demand)} / ${amount(budget.limit)} `),
    fg(ink.muted)(unit),
  ]);
}
