import { skitConfigurationLayer } from "../../configuration/skit-configuration.js";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { handleLibraryCommand } from "../../application.js";
import { MissingRequirement } from "../../workflows/failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { localFlags } from "../../commands/parameters.js";
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
    return yield* new MissingRequirement({
      command: "security review",
      requires: "<skill>",
      hint: "`skit list --json` lists retained skills.",
    });
  return yield* library.securityReviewEffect(query);
});

const skill = Argument.String("skill");

export const securityReviewCliCommand = Command.make(
  "review",
  { skill, ...localFlags },
  ({ skill, home }) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* securityReviewCommand({ securityReviewEffect: reviewSecurity }, skill);
        yield* renderer.result(result("securityReview", value));
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Review security findings for one exact Skill version in your Library."),
  Command.withExamples([{ command: "skit security review owner/tools:review --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [outputContracts.securityReview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
