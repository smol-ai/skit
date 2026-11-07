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

/** Captures all cleanup evidence and previews against the same Library revision. */
export const openDoctorCleanupSelection = Effect.fn("Doctor.openCleanupSelection")(function* (
  budgets: readonly Estimated[],
  configuration: InventoryRootOptions,
  days: number,
  progress: (completed: number, total: number) => Effect.Effect<void>,
) {
  const selection = yield* Effect.flatMap(Library.Service, (library) => library.enable.open());
  const usage = yield* scanLocalUsage(selection.view.installedSkills, {
    userHome: configuration.home,
    days,
    progress,
  });
  const candidates = selection.suggestCleanup(budgets, usage);
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
      const intents: SetEnabledIntent[] = Object.values(groups).map((members) => ({
        subject: members[0].collectionId,
        enabled: false,
        where: [members[0].scope],
        members: members.map((candidate) => candidate.name),
      }));
      return selection.planMany(intents);
    },
  };
});
