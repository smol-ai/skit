import * as Library from "@smolai/skit-core/library";
import type { ListingBudget } from "@smolai/skit-core/harnesses";
import { Array, Effect } from "effect";
import { resolve } from "node:path";
import { type SetEnabledIntent } from "@smolai/skit-core/library/enable";
import type { InventoryRootOptions } from "@smolai/skit-core/library/routing";
import { scanLocalUsage } from "../usage/scan.js";

type Estimated = Extract<ListingBudget, { _tag: "Estimated" }>;
export const overBudget = (budgets: readonly ListingBudget[]): Estimated[] =>
  budgets.filter(
    (budget): budget is Estimated => budget._tag === "Estimated" && budget.demand > budget.limit,
  );

/** Read cleanup evidence from one explicit Library revision. */
export const scanDoctorCleanup = Effect.fn("Doctor.scanCleanup")(function* (
  budgets: readonly Estimated[],
  library: Library.Interface,
  configuration: InventoryRootOptions,
  days: number,
  progress: (completed: number, total: number) => Effect.Effect<void>,
) {
  const base = yield* library.read;
  const view = yield* library.list({ base });
  const usage = yield* scanLocalUsage(view.installedSkills, {
    userHome: configuration.home,
    days,
    progress,
  });
  const candidates = library.suggestCleanup(budgets, usage, { base });
  return {
    base,
    usage,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      collectionLabel:
        view.collections.find((item) => item.id === candidate.collectionId)?.label ??
        candidate.collectionId,
    })),
  };
});

/** Group the chosen rows into disable intents; Library resolves and plans them. */
export const cleanupIntents = (
  selected: ReturnType<Library.Interface["suggestCleanup"]>,
): SetEnabledIntent[] => {
  const groups = Array.groupBy(selected, (candidate) =>
    JSON.stringify([
      candidate.collectionId,
      candidate.scope.kind,
      candidate.scope.kind === "global" ? "" : resolve(candidate.scope.root),
    ]),
  );
  return Object.values(groups).map((members) => ({
    subject: members[0].collectionId,
    enabled: false,
    where: [members[0].scope],
    members: members.map((candidate) => candidate.name),
  }));
};
