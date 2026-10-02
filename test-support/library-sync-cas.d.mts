export const librarySyncCasScenarios: readonly {
  readonly id: string;
  readonly base: "absent" | "empty" | "existing";
  readonly operation: "race" | "stale" | "retry";
  readonly statuses: readonly number[];
  readonly conflict: { readonly error: "REVISION_CONFLICT" };
}[];
