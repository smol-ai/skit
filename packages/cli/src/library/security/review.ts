import { Effect } from "effect";
import { MissingRequirement } from "../../commands/input-failures.js";

export interface SecurityReviewLibrary<Review, ReviewError, ReviewServices> {
  readonly securityReviewEffect: (
    query: string,
  ) => Effect.Effect<Review, ReviewError, ReviewServices>;
}

export const securityReviewCommand = Effect.fn("CLI.securityReview")(function* <
  Review,
  ReviewError,
  ReviewServices,
>(library: SecurityReviewLibrary<Review, ReviewError, ReviewServices>, query?: string) {
  if (!query)
    return yield* new MissingRequirement({ reason: { _tag: "SecuritySubject", action: "review" } });
  return yield* library.securityReviewEffect(query);
});
