import { skitConfigurationLayer } from "@smolai/skit-core/platform";
import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { handleLibraryCommand } from "../../commands/handler.js";
import { MissingRequirement } from "../../commands/input-failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { securityOutputContracts } from "./output.js";
import { localFlags } from "../../commands/parameters.js";
import { reviewLibrarySecurity as reviewSecurity } from "./operation.js";
import { Renderer } from "../../terminal/renderer.js";
import { encodeResult as result } from "../../commands/encode-result.js";

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
        yield* renderer.result(
          result("securityReview", securityOutputContracts.securityReview, value),
        );
      }),
    ).pipe(Effect.provide(skitConfigurationLayer(Option.getOrUndefined(home)))),
).pipe(
  Command.withDescription("Review security findings for one exact Skill version in your Library."),
  Command.withExamples([{ command: "skit security review owner/tools:review --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [securityOutputContracts.securityReview],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
