import { SkitConfiguration } from "@smolai/skit-core/platform";
import { Effect } from "effect";
import {
  acceptLibrarySecurityFinding,
  reviewLibrarySecurity as readSecurity,
} from "@smolai/skit-core/library/session";

export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (query: string) {
  return yield* readSecurity((yield* SkitConfiguration).skitHome, query);
});

export { acceptLibrarySecurityFinding };
