import { Effect } from "effect";
import { HarnessName, type SkillsDirectoryOverrides } from "../contracts.js";
import type { LibraryInventory } from "../../library/library-state.js";

import { harnessDrivers } from "../drivers.js";

export interface ListingOptions {
  readonly cwd: string;
  readonly home: string;
  readonly configHome?: string;
  readonly overrides?: SkillsDirectoryOverrides;
}

/** Every listing-capable Harness's estimate, in Harness order. */
export const readListingBudgets = Effect.fn("Listing.budgets")(function* (
  state: LibraryInventory,
  options: ListingOptions,
) {
  return yield* Effect.all(
    HarnessName.literals.flatMap((harness) => {
      const listing = harnessDrivers[harness].listing;
      return listing ? [listing(state, options)] : [];
    }),
    { concurrency: "unbounded" },
  );
});
