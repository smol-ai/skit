import { Library, type Hash } from "@smolai/skit-core";
import { Effect, Option } from "effect";
import { openLibraryView } from "../library-application/library-view.js";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  const view = yield* openLibraryView();
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
  return (yield* library.apply(plan)).result.review;
});
