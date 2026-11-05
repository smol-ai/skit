import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Library } from "@smolai/skit-core/library";
import { type Hash } from "@smolai/skit-core/shared";
import { Effect, Option } from "effect";
import { openLibraryView } from "@smolai/skit-core/library/session";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  const view = yield* Effect.flatMap(SkitConfiguration, (paths) => openLibraryView(paths.skitHome));
  return yield* view.securityReview(query);
});

export const acceptLibrarySecurityFinding = Effect.fn("Library.acceptSecurity")(function* (
  query: string,
  input: {
    readonly fingerprint: Hash;
    readonly principal: string;
    readonly rationale: string;
    readonly expiresAt?: string;
  },
) {
  const library = yield* Library.Service;
  const plan = yield* library.plan(
    { _tag: "AcceptFinding", query, ...input, expiresAt: Option.fromNullishOr(input.expiresAt) },
    { base: yield* library.read },
  );
  return (yield* library.apply({ _tag: "Apply", plan: plan })).result.review;
});
