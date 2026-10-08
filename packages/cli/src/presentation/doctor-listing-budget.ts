import { Match } from "effect";
import { createColors } from "picocolors";
import { largeListingEntries, type ListingBudget } from "@smolai/skit-core";
import { harnessLabel } from "../harness/catalog.js";
import { compactHomePath } from "./home-path.js";

const amount = (value: number) => value.toLocaleString("en-US");

export function renderDoctorListingBudget(
  budget: ListingBudget,
  context: { readonly color: boolean; readonly detail: "summary" | "full" },
): string[] {
  const color = createColors(context.color);
  const label = color.bold(harnessLabel(budget.harness));
  return Match.value(budget).pipe(
    Match.tagsExhaustive({
      Unavailable: (b) => [
        `  ${color.yellow("!")} ${label} · budget unavailable`,
        `      ${color.dim(b.detail)}`,
      ],
      DemandOnly: (b) => [
        `  ${label} · ~${amount(b.demand)} ${b.unit === "characters" ? "characters" : "tokens"} · limit unknown`,
        ...(context.detail === "full"
          ? [b.basis, ...b.coverage].map((line) => `      ${color.dim(line)}`)
          : []),
      ],
      Estimated: (b) => {
        const unit = b.unit === "characters" ? "characters" : "tokens";
        const outside = b.demand > b.limit;
        const lines = [
          `  ${outside ? color.yellow("! Over budget") : color.green("✓ Within budget")} · ${label} · ~${amount(b.demand)} / ${amount(b.limit)} ${unit} · ${((b.demand / b.limit) * 100).toFixed(1)}%`,
        ];
        for (const warning of b.warnings ?? []) lines.push(`      ${color.yellow(warning)}`);
        if (b.shortened)
          lines.push(
            `      ${color.yellow(`${b.shortened} description${b.shortened === 1 ? "" : "s"} shortened`)}`,
          );
        if (b.omitted)
          lines.push(
            `      ${color.yellow(`${b.omitted} skill${b.omitted === 1 ? "" : "s"} omitted`)}`,
          );
        if (b.descriptionsDropped.max) {
          const { min, max } = b.descriptionsDropped;
          lines.push(
            `      ${color.yellow(`${min === max ? min : `${min}–${max}`} descriptions at risk of being dropped`)}`,
          );
        }
        const large = largeListingEntries(b);
        if (large.length) {
          lines.push(`      ${color.dim("Skills over 1% of budget, before trimming:")}`);
          for (const skill of large) {
            lines.push(
              `        ${color.bold(skill.name)} · ~${amount(skill.demand)} ${unit} · ${((skill.demand / b.limit) * 100).toFixed(1)}%`,
            );
            if (
              context.detail === "full" ||
              large.some((other) => other !== skill && other.name === skill.name)
            )
              lines.push(`          ${color.dim(compactHomePath(skill.path))}`);
          }
        }
        if (context.detail === "full")
          lines.push(...[b.basis, ...b.coverage].map((line) => `      ${color.dim(line)}`));
        return lines;
      },
    }),
  );
}
