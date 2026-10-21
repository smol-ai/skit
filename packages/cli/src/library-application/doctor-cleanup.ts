import {
  LibraryStore,
  type LibraryState,
  type ListingBudget,
  type UsageReport,
  type SkitBindingScope,
} from "@smolai/skit-core";
import { Array, Effect } from "effect";
import { resolve } from "node:path";
import { bindingChangeSelection, type BindingChangeIntent } from "./binding-changes.js";
import { bindingPlacements } from "../workflows/library/binding-selection.js";
import {
  bindingRoot,
  existingRepositoryProjectionRoot,
  type InventoryRootOptions,
} from "../projection/roots.js";
import { scanLocalUsage } from "./local-usage.js";

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

/** Captures all cleanup evidence and previews against the same Library revision. */
export const openDoctorCleanupSelection = Effect.fn("Doctor.openCleanupSelection")(function* (
  budgets: readonly Estimated[],
  configuration: InventoryRootOptions,
  days: number,
  progress: (completed: number, total: number) => Effect.Effect<void>,
) {
  const store = yield* LibraryStore;
  const state = yield* store.load;
  const selection = bindingChangeSelection(state, store.home, store.originalsPath);
  const usage = yield* scanLocalUsage(state, { userHome: configuration.home, days, progress });
  const candidates = suggestDoctorCleanup(state, budgets, usage, configuration);
  return {
    usage,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      collectionLabel:
        selection.view.collections.find((item) => item.id === candidate.collectionId)?.label ??
        candidate.collectionId,
    })),
    preview: (ids: readonly string[]) => {
      const selected = candidates.filter((candidate) => ids.includes(candidate.id));
      const groups = Array.groupBy(selected, (candidate) =>
        JSON.stringify([
          candidate.collectionId,
          candidate.scope.kind,
          candidate.scope.kind === "global" ? "" : resolve(candidate.scope.root),
        ]),
      );
      const intents: BindingChangeIntent[] = Object.values(groups).map((members) => ({
        subject: members[0].collectionId,
        enabled: false,
        where: [members[0].scope],
        members: members.map((candidate) => candidate.name),
      }));
      return selection.previewMany(intents, configuration);
    },
  };
});
