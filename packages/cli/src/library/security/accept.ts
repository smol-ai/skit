import type { Hash } from "@smolai/skit-core/shared";
import { Effect, Schema } from "effect";

import { FindingFingerprintInvalid } from "./failures.js";
import { MissingRequirement } from "../../commands/input-failures.js";

const FindingFingerprint = Schema.TemplateLiteral([
  "sha256:",
  Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
]);

export interface SecurityAcceptLibrary<Review, AcceptError, AcceptServices> {
  readonly acceptSecurityFindingEffect: (
    query: string,
    input: {
      fingerprint: Hash;
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
      hint: "`skit security review <skill> --json` lists each finding's fingerprint.",
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
