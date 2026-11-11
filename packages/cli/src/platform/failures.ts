import { describeFailure } from "../terminal/failure.js";
import { HomeBusy } from "@smolai/skit-core/platform";
import { Match } from "effect";

export const platformFailure = Match.type<HomeBusy>().pipe(
  Match.tagsExhaustive({
    HomeBusy: ({ path }) =>
      describeFailure({
        summary: [`Another running SKIT process holds the home writer lock at ${path}`],
        next: ["Wait for the other SKIT process to finish, or stop it, then retry."],
      }),
  }),
);
