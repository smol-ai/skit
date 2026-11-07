import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { handleLibraryCommand } from "../application.js";
import { CommandMetadata } from "./metadata.js";
import { securityOutputContracts } from "../library/security/output.js";
import * as Library from "@smolai/skit-core/library";
import { securityAcceptCommand } from "../library/security/accept.js";
import { localFlags } from "./parameters.js";

import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "./encode-result.js";

const skill = Argument.String("skill");

const finding = Flag.String("finding").pipe(
  Flag.withDescription("Accept this exact finding fingerprint."),
);

const principal = Flag.String("principal").pipe(
  Flag.withDescription("Record the Principal granting acceptance."),
);

const rationale = Flag.String("rationale").pipe(
  Flag.withDescription("Record why this finding is accepted."),
);

const expiresAt = Flag.String("expires-at").pipe(
  Flag.withDescription("Expire acceptance at this canonical ISO instant."),
  Flag.optional,
);

export const securityAcceptCliCommand = Command.make(
  "accept",
  { skill, finding, principal, rationale, expiresAt, ...localFlags },
  ({ skill, finding, principal, rationale, expiresAt, home }) =>
    handleLibraryCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const library = yield* Library.Service;
        const value = yield* securityAcceptCommand(
          { acceptSecurityFindingEffect: library.acceptSecurityFinding },
          {
            query: skill,
            fingerprint: finding,
            principal,
            rationale,
            expiresAt: Option.getOrUndefined(expiresAt),
          },
        );
        yield* renderer.result(
          result("securityAccept", securityOutputContracts.securityAccept, value),
        );
      }),
      { home },
    ),
).pipe(
  Command.withDescription(
    "Accept one finding for installing one exact Skill version in your Library.",
  ),
  Command.withExamples([
    {
      command:
        "skit security accept owner/tools:review --finding sha256:... --principal tim --rationale reviewed",
    },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.read", "filesystem.write"] },
    outputSchemas: [securityOutputContracts.securityAccept],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
