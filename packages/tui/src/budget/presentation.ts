import { Match } from "effect";
import { largeListingEntries, type ListingBudget } from "./contracts.js";
import { harnessLabel } from "../../../cli/src/harness/catalog.js";
const amount = (n: number) => n.toLocaleString("en-US");
const unit = (b: Extract<ListingBudget, { _tag: "Estimated" | "DemandOnly" }>) =>
  b.unit === "characters" ? "characters" : "budget tokens";
export function listingBudgetSummary(budget: ListingBudget, compact = false): string {
  if (compact) {
    if (budget._tag === "Unavailable")
      return `${harnessLabel(budget.harness)}: listing demand unavailable`;
    const demand = `~${amount(budget.demand)} ${unit(budget)}`;
    return budget._tag === "DemandOnly"
      ? `${harnessLabel(budget.harness)}: ${demand} · limit unverified`
      : `${budget.demand > budget.limit ? "⚠" : "✓"} ${harnessLabel(budget.harness)}: ${demand} / ${amount(budget.limit)} · ${((budget.demand / budget.limit) * 100).toFixed(1)}%`;
  }
  return Match.value(budget).pipe(
    Match.tagsExhaustive({
      Unavailable: (b) => `${harnessLabel(b.harness)} listing demand: unavailable · ${b.detail}`,
      DemandOnly: (b) =>
        `${harnessLabel(b.harness)} listing demand: ~${amount(b.demand)} ${unit(b)} · limit unverified`,
      Estimated: (b) =>
        `${b.demand > b.limit ? "⚠ Outside budget" : "✓ Within budget"}${b.fidelity === "bounded" ? " (observed skills)" : ""} · ${harnessLabel(b.harness)} listing demand: ~${amount(b.demand)} / ${amount(b.limit)} ${unit(b)} · ${((b.demand / b.limit) * 100).toFixed(1)}%${b.demand > b.limit ? ` · ~${amount(b.demand - b.limit)} over budget` : ""}`,
    }),
  );
}
export function listingBudgetLines(b: ListingBudget, full = false): string[] {
  if (b._tag === "Unavailable") return [listingBudgetSummary(b)];
  const lines = [listingBudgetSummary(b), b.basis];
  if (b._tag === "Estimated") {
    if (b.shortened)
      lines.push(`Warning: estimated ${b.shortened} descriptions shortened to fit the budget.`);
    if (b.omitted) lines.push(`Warning: estimated ${b.omitted} skills omitted from the listing.`);
    if (b.descriptionsDropped.max)
      lines.push(
        `Warning: ${b.descriptionsDropped.min}–${b.descriptionsDropped.max} descriptions at risk; which descriptions disappear depends on native invocation history. Names remain listed.`,
      );
    if (b.fidelity === "bounded")
      lines.push(
        "Comparison uses a partial filesystem listing with estimated separators; native allocation is not predicted.",
      );
    lines.push("Skills exceeding 1% of the skill listing budget (before budget trimming):");
    const entries = largeListingEntries(b);
    if (!entries.length) lines.push("  None");
    for (const e of entries) {
      lines.push(
        `  ${e.name} · ~${amount(e.demand)} ${unit(b)} · ${((e.demand / b.limit) * 100).toFixed(1)}%`,
      );
      if (full || entries.some((other) => other !== e && other.name === e.name))
        lines.push(`    ${e.path}`);
    }
  } else lines.push("The 1% contributor cutoff is unavailable until a character limit is known.");
  return [...lines, ...b.coverage];
}
export function collectionListingSummary(b: ListingBudget, id: string): string {
  if (b._tag === "Unavailable") return `${harnessLabel(b.harness)}: unavailable`;
  const c = b.collections.find((c) => c.collectionId === id);
  if (!c) return `${harnessLabel(b.harness)}: not discovered here`;
  return `${harnessLabel(b.harness)} demand: ~${amount(c.demand)} ${unit(b)}${b._tag === "Estimated" ? ` · ${((c.demand / b.limit) * 100).toFixed(1)}% of budget` : " · limit unverified"}`;
}
