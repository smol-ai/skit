import { withLibraryWriter } from "@smolai/skit-core";
import {
  acceptSecurityFindingFromState,
  LibraryStore,
  securityReviewFromState,
  type Hash,
} from "@smolai/skit-core";
import { Effect } from "effect";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  const state = yield* (yield* LibraryStore).load;
  return yield* securityReviewFromState(state, query);
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
  const state = yield* (yield* LibraryStore).load;
  return yield* acceptSecurityFindingFromState(state, query, input);
}, withLibraryWriter);
