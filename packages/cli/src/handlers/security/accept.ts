import type { Digest } from "@smolai/skit-core";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { handleCommand } from "../../application.js";
import { FindingFingerprintInvalid } from "../../audit/failures.js";
import { MissingRequirement } from "../failures.js";
import { CommandMetadata } from "../../commands/metadata.js";
import { outputContracts } from "../../commands/output-contracts.js";
import { homePath, localFlags } from "../../commands/parameters.js";
import { acceptLibrarySecurityFinding } from "../../library/security.js";
import { Renderer } from "../../presentation/renderer.js";
import { result } from "../contracts.js";

const FindingFingerprint = Schema.TemplateLiteral([
  "sha256:",
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
]);

export interface SecurityAcceptLibrary<Review, AcceptError, AcceptServices> {
  readonly acceptSecurityFindingEffect: (
    query: string,
    input: {
      fingerprint: Digest;
      principal: string;
      rationale: string;
      expiresAt?: string;
    },
  ) => Effect.Effect<Review, AcceptError, AcceptServices>;
}

export const securityAcceptCommand = Effect.fn("CLI.securityAccept")(function* <
  Review,
  AcceptError,
  AcceptServices,
>(
  library: SecurityAcceptLibrary<Review, AcceptError, AcceptServices>,
  options: {
    readonly query?: string;
    readonly fingerprint?: string;
    readonly principal?: string;
    readonly rationale?: string;
    readonly expiresAt?: string;
  },
) {
  if (!options.query)
    return yield* new MissingRequirement({ command: "security accept", requires: "<skill>" });
  if (!options.fingerprint || !options.principal || !options.rationale)
    return yield* new MissingRequirement({
      command: "security accept",
      requires: "--finding, --principal, and --rationale",
    });
  const fingerprintInput = options.fingerprint;
  const fingerprint = yield* Schema.decodeUnknownEffect(FindingFingerprint)(fingerprintInput).pipe(
    Effect.mapError(() => new FindingFingerprintInvalid({ value: fingerprintInput })),
  );

  return yield* library.acceptSecurityFindingEffect(options.query, {
    fingerprint,
    principal: options.principal,
    rationale: options.rationale,
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
  });
});

const skill = Argument.string("skill");
const finding = Flag.string("finding").pipe(
  Flag.withDescription("Accept this exact finding fingerprint."),
);
const principal = Flag.string("principal").pipe(
  Flag.withDescription("Record the Principal granting acceptance."),
);
const rationale = Flag.string("rationale").pipe(
  Flag.withDescription("Record why this finding is accepted."),
);
const expiresAt = Flag.string("expires-at").pipe(
  Flag.withDescription("Expire acceptance at this canonical ISO instant."),
  Flag.optional,
);

export const securityAcceptCliCommand = Command.make(
  "accept",
  { skill, finding, principal, rationale, expiresAt, ...localFlags },
  ({ skill, finding, principal, rationale, expiresAt, home }) => {
    const selectedHome = homePath(home);
    return handleCommand(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        const value = yield* securityAcceptCommand(
          {
            acceptSecurityFindingEffect: (query, input) =>
              acceptLibrarySecurityFinding(query, input),
          },
          {
            query: skill,
            fingerprint: finding,
            principal,
            rationale,
            expiresAt: Option.getOrUndefined(expiresAt),
          },
        );
        yield* renderer.result(result("securityAccept", outputContracts.securityAccept, value));
      }),
      selectedHome,
    );
  },
).pipe(
  Command.withDescription("Accept one finding for Projection of an exact retained Skill Artifact."),
  Command.withExamples([
    {
      command:
        "skit security accept owner/tools:review --finding sha256:... --principal tim --rationale reviewed",
    },
  ]),
  Command.annotate(CommandMetadata, {
    effects: { capabilities: ["filesystem.write"] },
    outputSchemas: [outputContracts.securityAccept],
    exitCodes: [0, 11, 12, 64, 65],
    interactive: false,
  }),
);
