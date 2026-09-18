import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { MissingRequirement } from "../failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { reviewLibrarySecurity as reviewSecurity } from "../../library/security.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

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
    return yield* new MissingRequirement({ command: "security review", requires: "<skill>" });
  return yield* library.securityReviewEffect(query);
});

const skill = Argument.string("skill");

export const securityReviewCliCommand = Command.make(
  "review",
  { skill, ...localFlags },
  ({ skill, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* securityReviewCommand({ securityReviewEffect: reviewSecurity }, skill);
        yield* renderer.result(result("securityReview", outputContracts.securityReview, value));
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Review security findings for an exact retained Skill Artifact."),
  Command.withExamples([{ command: "skit security review owner/tools:review --json" }]),
  Command.annotate(CommandMetadata, {
    outputSchemas: [outputContracts.securityReview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
