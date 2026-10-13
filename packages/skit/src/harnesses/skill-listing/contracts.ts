import { Data, Schema } from "effect";
import { HarnessName } from "../../vocabulary.js";
import { FailureTypeId, type SkitFailure } from "../../shared/failure.js";

export class ListingReadFailure
  extends Data.TaggedError("ListingReadFailure")<{ detail: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "OPERATION_FAILED" as const;
  readonly remediation =
    "Check that the Harness's skill directories and settings are readable, then retry.";
  get message(): string {
    return this.detail;
  }
}

export const ListingEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  demand: Schema.Number,
  collectionId: Schema.optionalKey(Schema.String),
});
export type ListingEntry = typeof ListingEntry.Type;
/** The Harnesses whose skill listing SKIT can estimate; each one's driver carries the estimator. */
export const ListingHarness = HarnessName.pick(["codex", "claude-code"]);
export type ListingHarness = typeof ListingHarness.Type;
const fields = {
  harness: ListingHarness,
  cwd: Schema.String,
  model: Schema.NullOr(Schema.String),
  unit: Schema.Literals(["budget-tokens", "characters"]),
  demand: Schema.Number,
  entries: Schema.Array(ListingEntry),
  collections: Schema.Array(
    Schema.Struct({ collectionId: Schema.String, skills: Schema.Number, demand: Schema.Number }),
  ),
  basis: Schema.String,
  coverage: Schema.Array(Schema.String),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
};
export const ListingBudget = Schema.Union([
  Schema.TaggedStruct("Unavailable", {
    harness: fields.harness,
    cwd: Schema.String,
    detail: Schema.String,
  }),
  Schema.TaggedStruct("DemandOnly", fields),
  Schema.TaggedStruct("Estimated", {
    ...fields,
    limit: Schema.Number,
    fitted: Schema.NullOr(Schema.Number),
    shortened: Schema.Number,
    descriptionsDropped: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
    omitted: Schema.Number,
    fidelity: Schema.Literals(["modelled", "bounded"]),
  }),
]);
export type ListingBudget = typeof ListingBudget.Type;

export function largeListingEntries(budget: ListingBudget): readonly ListingEntry[] {
  return budget._tag !== "Estimated"
    ? []
    : budget.entries
        .filter((e) => e.demand * 100 > budget.limit)
        .sort(
          (a, b) =>
            b.demand - a.demand || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
        );
}
