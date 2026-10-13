import { FailureTypeId, type SkitFailure } from "@smolai/skit-core";
import { Data } from "effect";

/** Two Bindings route to one destination, so neither can be materialized safely. */
export class RoutesCollide
  extends Data.TaggedError("RoutesCollide")<{ detail: string }>
  implements SkitFailure
{
  readonly [FailureTypeId] = FailureTypeId;
  readonly code = "TARGET_COLLISION" as const;
  readonly remediation = "Choose one Scope or route for each destination, then retry.";
  get message(): string {
    return `${this.detail}\nChoose one Scope or route for each destination.`;
  }
}
