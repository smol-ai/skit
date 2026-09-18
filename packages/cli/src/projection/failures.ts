import { Data } from "effect";

/** Two Bindings route to one destination, so neither can be materialized safely. */
export class RoutesCollide extends Data.TaggedError("RoutesCollide")<{ detail: string }> {
  readonly code = "TARGET_COLLISION" as const;
  get message(): string {
    return `${this.detail}\nChoose one Scope or route for each destination.`;
  }
}
