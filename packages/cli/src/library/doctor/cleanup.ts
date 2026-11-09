import { type ListingBudget } from "@smolai/skit-core/harnesses";
import { Effect } from "effect";
import * as Library from "@smolai/skit-core/library";
import { setEnabledOutcomes } from "@smolai/skit-core/library/enable";
import { scanDoctorCleanup, cleanupIntents, overBudget } from "./selection.js";
import { type InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { renderDoctorBudgetSelection } from "./budget.js";
import { Renderer } from "../../terminal/renderer.js";
import { terminalColorEnabled } from "../../terminal/style.js";
import { Prompter } from "../../terminal/prompter.js";
import { encodeResult as result } from "../../commands/encode-result.js";
import { enableOutputContracts } from "../enable.js";

export const presentDoctorCleanup = Effect.fn("Doctor.cleanup")(function* (
  budgets: readonly ListingBudget[],
  configuration: InventoryRootOptions,
  days: number,
  dryRun = false,
) {
  const excessive = overBudget(budgets);
  if (!excessive.length) return false;
  const library = yield* Library.Service;
  const renderer = yield* Renderer;
  const prompter = yield* Prompter;
  const selection = yield* renderer.withStatus(
    "Scanning local skill activity",
    scanDoctorCleanup(excessive, library, configuration, days, (done, total) =>
      renderer.updateStatus(`Scanning local skill activity: ${done}/${total} files`),
    ),
  );
  const { usage, candidates } = selection;
  const withoutHistory = excessive
    .filter(
      (budget) =>
        !usage.coverage.some(
          (root) =>
            root.harness === budget.harness &&
            root.status === "available" &&
            root.windowRecords > 0,
        ),
    )
    .map((budget) => budget.harness);
  yield* renderer.note(
    [
      `Suggested skills have no observed usage in the last ${days} days across all local projects (${usage.window.start.slice(0, 10)}–${usage.window.end.slice(0, 10)}).`,
      ...(withoutHistory.length
        ? [
            `No transcript history in this window for ${withoutHistory.join(", ")}; those suggestions are not preselected.`,
          ]
        : []),
    ].join("\n"),
    "Suggested skill cleanup",
  );
  if (!candidates.length) {
    yield* renderer.note(
      "No unused managed skills could be safely matched to the over-budget listings.",
      "Nothing to suggest",
    );
    return false;
  }
  const budgetSummary = (ids: readonly string[], columns = 80) =>
    renderDoctorBudgetSelection(
      excessive,
      Object.fromEntries(
        excessive.map((budget) => [
          budget.harness,
          candidates
            .filter((candidate) => ids.includes(candidate.id))
            .reduce((sum, candidate) => sum + (candidate.costs[budget.harness] ?? 0), 0),
        ]),
      ),
      columns,
      terminalColorEnabled(),
    );
  const chosen = yield* prompter.multiselect(
    `Skills to disable | last ${days} days`,
    candidates.map((c) => ({
      value: c.id,
      label: c.scope.kind === "global" ? c.name : `${c.name} | in ${c.scope.root}`,
      hint: `${Math.max(...excessive.map((b) => ((c.costs[b.harness] ?? 0) / b.limit) * 100)).toFixed(1)}% of budget`,
      detail: `Collection: ${c.collectionLabel}`,
      selected: c.selected,
    })),
    { maxItems: 8, summary: budgetSummary },
  );
  const selected = candidates.filter((c) => chosen.includes(c.id));
  if (!selected.length) return false;
  const plan = yield* library.planEnabled(cleanupIntents(selected), { base: selection.base });
  for (const change of plan.changes)
    yield* renderer.result(result("disablePlan", enableOutputContracts.disablePlan, change));
  yield* renderer.note(
    budgetSummary(chosen).join("\n") +
      "\nRed marks demand over the limit. Estimates subtract listed costs; native precedence can expose other skills. Doctor will recheck after applying.\nDisabling part of a followed collection keeps its other current skills individually; that scope stops following future collection additions.",
    "Preview",
  );
  if (dryRun) return false;
  if (!(yield* prompter.confirm(`Disable ${selected.length} selected skills at the shown scopes?`)))
    return false;
  const outcomes = yield* renderer.withStatus(
    "Disabling selected skills",
    library
      .apply({ _tag: "Apply", plan: plan.plan })
      .pipe(Effect.flatMap((outcome) => setEnabledOutcomes(outcome.result))),
  );
  for (const outcome of outcomes)
    yield* renderer.result(result("disable", enableOutputContracts.disable, outcome.value));
  return true;
});
