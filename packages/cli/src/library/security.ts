import {
  acceptSecurityFindingFromStateEffect,
  LibraryStore,
  securityReviewFromStateEffect,
  type Digest,
} from "@smolai/skit-core";
import { Effect } from "effect";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  const state = yield* (yield* LibraryStore).load;
  return yield* securityReviewFromStateEffect(state, query);
});

export const acceptLibrarySecurityFinding = Effect.fn("Library.acceptSecurity")(function* (
  query: string,
  input: {
    readonly fingerprint: Digest;
    readonly principal: string;
    readonly rationale: string;
    readonly expiresAt?: string;
  },
) {
  const state = yield* (yield* LibraryStore).load;
  return yield* acceptSecurityFindingFromStateEffect(state, query, input);
});
