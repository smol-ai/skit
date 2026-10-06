import { Effect } from "effect";
import { join } from "node:path";
import type { LibraryState } from "../../library/library-state.js";
import { codexListingResult, type ListingBudget } from "./contracts.js";
import { readLibraryCodexListingSnapshot, type CodexListingSnapshot } from "./codex.js";
import { readClaudeListingSnapshot, type ClaudeListingSnapshot } from "./claude.js";

export interface ListingOptions {
  readonly cwd: string;
  readonly home: string;
  readonly configHome?: string;
  readonly overrideRoot?: string;
  readonly claudeRoot?: string;
}
export interface ListingSnapshot {
  readonly codex: CodexListingSnapshot;
  readonly claude: ClaudeListingSnapshot;
}
export const listingRoots = (options: ListingOptions) => ({
  home: options.home,
  configHome: options.configHome ?? join(options.home, ".config"),
  overrides: {
    ...(options.overrideRoot === undefined ? {} : { codex: options.overrideRoot }),
    ...(options.claudeRoot === undefined ? {} : { claude: options.claudeRoot }),
  },
});
export const readListingSnapshot = Effect.fn("Listing.discover")(function* (
  state: LibraryState,
  options: ListingOptions,
) {
  const [codex, claude] = yield* Effect.all(
    [
      readLibraryCodexListingSnapshot(state, options),
      readClaudeListingSnapshot(state, { ...listingRoots(options), cwd: options.cwd }),
    ],
    { concurrency: 2 },
  );
  return { codex, claude } satisfies ListingSnapshot;
});
export function listingResults(snapshot: ListingSnapshot): readonly ListingBudget[] {
  return [codexListingResult(snapshot.codex), snapshot.claude.budget];
}
export const readListingBudgets = Effect.fn("Listing.budgets")(function* (
  state: LibraryState,
  options: ListingOptions,
) {
  return listingResults(yield* readListingSnapshot(state, options));
});
