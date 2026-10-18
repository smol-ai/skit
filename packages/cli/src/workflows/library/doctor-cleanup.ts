import {
  LibraryStore,
  SkillUsage,
  UsageHarness,
  harnessDrivers,
  skillUsageLayer,
  type LibraryState,
  type ListingBudget,
  type UsageReport,
  type UsageRoot,
  type SkitBindingScope,
} from "@smolai/skit-core";
import { Config, Effect } from "effect";
import { join, resolve } from "node:path";
import {
  openBindingChangeSelection,
  applyBindingChanges,
  type BindingChangeIntent,
} from "../../library-application/binding-changes.js";
import { bindingPlacements, sameBindingScope } from "./binding-selection.js";
import {
  bindingRoot,
  existingRepositoryProjectionRoot,
  type InventoryRootOptions,
} from "../../projection/roots.js";
import { renderDoctorBudgetSelection } from "../../presentation/doctor-listing-budget.js";
import { Renderer } from "../../presentation/renderer.js";
import { terminalColorEnabled } from "../../presentation/terminal-style.js";
import { Prompter } from "../../presentation/prompter.js";
import { result } from "../../handlers/contracts.js";

type Estimated = Extract<ListingBudget, { _tag: "Estimated" }>;
export interface CleanupCandidate {
  readonly id: string;
  readonly skillId: string;
  readonly name: string;
  readonly collectionId: string;
  readonly scope: SkitBindingScope;
  readonly costs: Readonly<Record<string, number>>;
  readonly hasUsageHistory: boolean;
  readonly selected: boolean;
}

export const overBudget = (budgets: readonly ListingBudget[]): Estimated[] =>
  budgets.filter(
    (budget): budget is Estimated => budget._tag === "Estimated" && budget.demand > budget.limit,
  );

/** Match exact managed documents and scopes; name-only usage is a conservative veto. */
export function suggestDoctorCleanup(
  state: LibraryState,
  budgets: readonly Estimated[],
  usage: UsageReport,
  configuration: InventoryRootOptions,
): CleanupCandidate[] {
  const candidates = new Map<string, Omit<CleanupCandidate, "selected">>();
  const placements = bindingPlacements(state);
  for (const budget of budgets) {
    for (const entry of budget.entries) {
      const projection = state.projections.find(
        (p) => resolve(p.path, "SKILL.md") === resolve(entry.path) && p.status === "installed",
      );
      const skill = state.skills.find((s) => s.skill_id === projection?.skill_id);
      if (!projection || !skill || projection.target === "legacy" || entry.demand <= 0) continue;
      const target = projection.target;
      // Any observed access protects the skill, including zero-use raw read evidence.
      if (
        usage.rows.some(
          (row) =>
            (row.skillId === skill.skill_id ||
              row.name === skill.name ||
              row.name === entry.name) &&
            row.calls + row.loads + row.reads + row.uses > 0,
        )
      )
        continue;
      const matching = placements.filter(
        (p) =>
          p.skillIds.includes(skill.skill_id) &&
          resolve(
            p.scope.kind === "repository"
              ? (existingRepositoryProjectionRoot(state, { scope: p.scope, entries: [] }, target) ??
                  bindingRoot(target, p.scope, configuration))
              : bindingRoot(target, p.scope, configuration),
          ) === resolve(projection.root),
      );
      if (matching.length !== 1) continue;
      const scope = matching[0].scope;
      const id = `${skill.skill_id}:${scope.kind === "global" ? "global" : resolve(scope.root)}`;
      const previous = candidates.get(id);
      const coverage = usage.coverage.filter((root) => root.harness === budget.harness);
      const hasUsageHistory = coverage.some(
        (root) => root.status === "available" && root.windowRecords > 0,
      );
      candidates.set(id, {
        id,
        skillId: skill.skill_id,
        name: skill.name,
        collectionId: skill.collection_id,
        scope,
        costs: {
          ...previous?.costs,
          [budget.harness]: (previous?.costs[budget.harness] ?? 0) + entry.demand,
        },
        hasUsageHistory: hasUsageHistory && (previous?.hasUsageHistory ?? true),
      });
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => {
    const score = (candidate: typeof a) =>
      budgets.reduce(
        (sum, budget) => sum + (candidate.costs[budget.harness] ?? 0) / budget.limit,
        0,
      );
    return (
      Number(b.hasUsageHistory) - Number(a.hasUsageHistory) ||
      score(b) - score(a) ||
      a.id.localeCompare(b.id)
    );
  });
  const remaining = new Map(budgets.map((b) => [b.harness, b.demand - b.limit]));
  return ranked.map((candidate) => {
    const selected =
      candidate.hasUsageHistory &&
      budgets.some(
        (b) => (remaining.get(b.harness) ?? 0) > 0 && (candidate.costs[b.harness] ?? 0) > 0,
      );
    if (selected)
      for (const budget of budgets)
        remaining.set(
          budget.harness,
          (remaining.get(budget.harness) ?? 0) - (candidate.costs[budget.harness] ?? 0),
        );
    return { ...candidate, selected };
  });
}


export const presentDoctorCleanup = Effect.fn("Doctor.cleanup")(function* (
  budgets: readonly ListingBudget[],
  configuration: InventoryRootOptions,
  days: number,
  dryRun = false,
) {
  const excessive = overBudget(budgets);
  if (!excessive.length) return false;
  const renderer = yield* Renderer;
  const prompter = yield* Prompter;
  const store = yield* LibraryStore;
  // Held before scanning and prompting: apply rejects changes to this captured Library.
  const selection = yield* openBindingChangeSelection();
  const state = yield* store.load;
  const roots: UsageRoot[] = [];
  for (const harness of UsageHarness.literals) {
    const transcripts = harnessDrivers[harness].transcripts;
    const home = yield* Config.String(transcripts.home.variable).pipe(
      Config.withDefault(join(configuration.home, transcripts.home.directory)),
    );
    for (const directory of transcripts.directories)
      roots.push({ harness, root: join(resolve(home), directory) });
  }
  const usage = yield* renderer.withStatus(
    "Scanning local skill activity",
    Effect.gen(function* () {
      const scanner = yield* SkillUsage;
      return yield* scanner.scan({
        roots,
        days,
        projections: state.projections.flatMap((p) => {
          const skill = state.skills.find((s) => s.skill_id === p.skill_id);
          return skill ? [{ path: p.path, skillId: skill.skill_id, name: skill.name }] : [];
        }),
        progress: (done, total) =>
          renderer.updateStatus(`Scanning local skill activity: ${done}/${total} files`),
      });
    }).pipe(Effect.provide(skillUsageLayer)),
  );
  const candidates = suggestDoctorCleanup(state, excessive, usage, configuration);
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
    `Skills to disable · last ${days} days`,
    candidates.map((c) => ({
      value: c.id,
      label: c.scope.kind === "global" ? c.name : `${c.name} · in ${c.scope.root}`,
      hint: `${Math.max(...excessive.map((b) => ((c.costs[b.harness] ?? 0) / b.limit) * 100)).toFixed(1)}% of budget`,
      detail: `Collection: ${selection.view.collections.find((item) => item.id === c.collectionId)?.label ?? c.collectionId}`,
      selected: c.selected,
    })),
    { maxItems: 8, summary: budgetSummary },
  );
  const selected = candidates.filter((c) => chosen.includes(c.id));
  if (!selected.length) return false;
  const intents: BindingChangeIntent[] = [];
  for (const candidate of selected) {
    const existing = intents.find(
      (intent) =>
        intent.subject === candidate.collectionId &&
        intent.where !== "where-enabled" &&
        intent.where.some((scope) => sameBindingScope(scope, candidate.scope)),
    );
    if (existing) continue;
    intents.push({
      subject: candidate.collectionId,
      enabled: false,
      where: [candidate.scope],
      members: selected
        .filter(
          (c) =>
            c.collectionId === candidate.collectionId && sameBindingScope(c.scope, candidate.scope),
        )
        .map((c) => c.name),
    });
  }
  const plan = yield* selection.previewMany(intents, configuration);
  for (const change of plan.changes) yield* renderer.result(result("disablePlan", change));
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
    applyBindingChanges(plan),
  );
  for (const outcome of outcomes) yield* renderer.result(result("disable", outcome.value));
  return true;
});
