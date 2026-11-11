import { renderListingProvenance } from "./listing-provenance.js";
import { listingUnavailable } from "./listing-failures.js";
import { Match } from "effect";
import { largeListingEntries, type ListingBudget } from "@smolai/skit-core/harnesses";
import { harnessLabel } from "@smolai/skit-core/harnesses";
import { Block } from "../../terminal/blocks.js";
import { renderBudgetMeter } from "../../terminal/budget-meter.js";

const demandAfter = (
  budget: { readonly demand: number; readonly harness: string },
  savings: Readonly<Record<string, number>>,
) => Math.max(0, budget.demand - (savings[budget.harness] ?? 0));

const amount = (value: number) => value.toLocaleString("en-US");

/** One Harness's listing budget: the estimate, what trimming costs, and the Skills that weigh most. */
export function renderDoctorListingBudget(
  budget: ListingBudget,
  detail: "summary" | "full",
): Block {
  const basis = (b: Exclude<ListingBudget, { _tag: "Unavailable" }>) =>
    detail === "full" ? [renderListingProvenance(b)] : [];
  return Block.Group({
    title: harnessLabel(budget.harness),
    children: Match.value(budget).pipe(
      Match.tagsExhaustive({
        Unavailable: (b) => [
          Block.Status({ tone: "warn", text: ["Budget unavailable"] }),
          Block.Note({ text: [{ dim: listingUnavailable(b.reason) }] }),
        ],
        DemandOnly: (b) => [
          Block.Status({
            tone: "info",
            text: [
              `~${amount(b.demand)} ${b.unit === "characters" ? "characters" : "tokens"}, limit unknown`,
            ],
          }),
          ...basis(b),
        ],
        Estimated: (b) => {
          const unit = b.unit === "characters" ? "characters" : "tokens";
          const outside = b.demand > b.limit;
          const { min, max } = b.descriptionsDropped;
          const large = largeListingEntries(b);
          // A path tells two same-named Skills apart; with full detail every path is shown.
          const path = (skill: (typeof large)[number]) =>
            detail === "full" ||
            large.some((other) => other !== skill && other.name === skill.name);
          const paths = large.some(path);
          return [
            Block.Status({
              tone: outside ? "warn" : "ok",
              text: [
                `${outside ? "Over budget" : "Within budget"}: ~${amount(b.demand)} / ${amount(b.limit)} ${unit} (${((b.demand / b.limit) * 100).toFixed(1)}%)`,
              ],
            }),
            ...[
              ...b.diagnostics.map(
                ({ path, diagnostic }) => `Skipped skill ${path}: ${diagnostic}`,
              ),
              ...(b.shortened
                ? [`${b.shortened} description${b.shortened === 1 ? "" : "s"} shortened`]
                : []),
              ...(b.omitted ? [`${b.omitted} skill${b.omitted === 1 ? "" : "s"} omitted`] : []),
              ...(max
                ? [`${min === max ? min : `${min}–${max}`} descriptions at risk of being dropped`]
                : []),
            ].map((warning) => Block.Status({ tone: "warn", text: [warning] })),
            ...(large.length
              ? [
                  Block.Group({
                    title: "Skills over 1% of budget, before trimming",
                    children: [
                      Block.Table({
                        columns: [
                          { title: "Skill" },
                          { title: unit === "characters" ? "Characters" : "Tokens", align: "end" },
                          { title: "Share", align: "end" },
                          ...(paths ? [{ title: "Path" }] : []),
                        ],
                        rows: large.map((skill) => [
                          [{ emph: skill.name }],
                          [`~${amount(skill.demand)}`],
                          [`${((skill.demand / b.limit) * 100).toFixed(1)}%`],
                          ...(paths ? [path(skill) ? [{ dim: skill.path }] : []] : []),
                        ]),
                      }),
                    ],
                  }),
                ]
              : []),
            ...basis(b),
          ];
        },
      }),
    ),
  });
}

/** The selected Skills determine demand; the terminal draws the prompt's meter. */
export function renderDoctorBudgetSelection(
  budgets: readonly ListingBudget[],
  savings: Readonly<Record<string, number>>,
  columns = 80,
): string[] {
  return budgets.flatMap((budget) => {
    if (budget._tag !== "Estimated") return [];
    return [
      renderBudgetMeter(
        {
          label: harnessLabel(budget.harness),
          demand: demandAfter(budget, savings),
          originalDemand: budget.demand,
          limit: budget.limit,
          unit: budget.unit === "characters" ? "characters" : "tokens",
        },
        columns,
      ),
    ];
  });
}

/** The confirmed selection is compared as facts; prompt bars remain inside the prompt. */
export function renderDoctorBudgetPreview(
  budgets: readonly ListingBudget[],
  savings: Readonly<Record<string, number>>,
): Block {
  return Block.Table({
    columns: [
      { title: "Harness" },
      { title: "Current", align: "end" },
      { title: "After", align: "end" },
      { title: "Limit", align: "end" },
      { title: "Unit" },
    ],
    rows: budgets.flatMap((budget) =>
      budget._tag !== "Estimated"
        ? []
        : [
            [
              [harnessLabel(budget.harness)],
              [`~${amount(Math.round(budget.demand))}`],
              [`~${amount(Math.round(demandAfter(budget, savings)))}`],
              [amount(budget.limit)],
              [budget.unit === "characters" ? "characters" : "tokens"],
            ],
          ],
    ),
  });
}
