import { describeFailure } from "../terminal/failure.js";
import { HomeBusy } from "@smolai/skit-core/platform";
import { Match } from "effect";

export const platformFailure = Match.type<HomeBusy>().pipe(
  Match.tagsExhaustive({
    HomeBusy: ({ path, owner }) =>
      describeFailure({
        summary: [
          owner === undefined
            ? `Another running SKIT process holds the home writer lock at ${path}`
            : `Legacy Library lock at ${path} is owned by ${owner.trim()}`,
        ],
        next: [
          owner === undefined
            ? "Wait for the other SKIT process to finish, or stop it, then retry."
            : "Confirm that the recorded owner has stopped before removing this legacy lock, then retry.",
        ],
      }),
  }),
);
