import { Option, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import {
  securityOutputContracts,
  reviewLibrarySecurity as reviewSecurity,
  securityReviewCommand,
} from "../library/security.js";
import { localFlags } from "./parameters.js";

import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

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
      Option.getOrUndefined(home),
    ),
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
