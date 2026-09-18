import {
  acceptPortableSecurityFindingFromStateEffect,
  LibraryStore,
  portableSecurityReviewFromStateEffect,
  type Digest,
} from "@smolai/skit-core";
import { Effect } from "effect";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  const portable = yield* (yield* LibraryStore).load;
  return yield* portableSecurityReviewFromStateEffect(portable, query);
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
  const portable = yield* (yield* LibraryStore).load;
  return yield* acceptPortableSecurityFindingFromStateEffect(portable, query, input);
});
