import { defineCommand } from "./definition.js";
import { Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { CommandMetadata } from "./metadata.js";
import { securityOutputContracts } from "../library/security/output.js";
import * as Library from "@smolai/skit-core/library";
import { securityReviewCommand } from "../library/security/review.js";

import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

const skill = Argument.String("skill").pipe(
  Argument.withDescription("Skill Reference whose security findings to inspect."),
);

export const securityReviewCliCommand = defineCommand("review", { skill }, ({ skill }) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const library = yield* Library.Service;
    const value = yield* securityReviewCommand(
      { securityReviewEffect: library.securityReview },
      skill,
    );
    yield* renderer.result(result("securityReview", securityOutputContracts.securityReview, value));
  }),
).pipe(
  Command.withDescription("Review security findings for one exact Skill version in your Library."),
  Command.withExamples([{ command: "skit security review owner/tools:review --json" }]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read"] },
    outputSchemas: [securityOutputContracts.securityReview],
    interactive: false,
  }),
);
