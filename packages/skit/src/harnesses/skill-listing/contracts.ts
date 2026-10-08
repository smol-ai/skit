import { Schema } from "effect";
import type { CodexListingSnapshot } from "./codex.js";

export class ListingReadFailure extends Schema.TaggedError<ListingReadFailure>()(
  "ListingReadFailure",
  { detail: Schema.String },
) {}

export const ListingEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  demand: Schema.Number,
  collectionId: Schema.optionalKey(Schema.String),
});
export type ListingEntry = typeof ListingEntry.Type;
const fields = {
  harness: Schema.Literals(["codex", "claude-code"]),
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

export function codexListingResult(snapshot: CodexListingSnapshot): ListingBudget {
  const b = snapshot.budget;
  if (b.status === "unavailable")
    return { _tag: "Unavailable", harness: "codex", cwd: b.cwd, detail: b.detail };
  return {
    _tag: "Estimated",
    harness: "codex",
    cwd: b.cwd,
    model: b.model,
    unit: b.unit,
    demand: b.requested,
    limit: b.limit,
    fitted: b.used,
    shortened: b.shortened,
    descriptionsDropped: { min: 0, max: 0 },
    omitted: b.omitted,
    fidelity: "modelled",
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
    entries: (snapshot.skillDemands ?? []).map((s) => ({
      name: s.name,
      path: s.path,
      demand: s.requested,
    })),
    collections: b.collections.map((c) => ({
      collectionId: c.collectionId,
      skills: c.skills,
      demand: c.requested,
    })),
    basis:
      b.unit === "characters"
        ? "Context window unknown; using Codex's 8,000-character fallback."
        : `${b.model ?? "Configured model"} · context ${b.contextWindow?.toLocaleString("en-US") ?? "unknown"}; native budget overrides take precedence.`,
    coverage: [
      "Includes native discoverable built-ins and other enabled skills. Path aliases are estimated; full instructions loaded later are additional.",
    ],
  };
}

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
