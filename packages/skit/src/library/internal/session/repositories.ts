import { Effect } from "effect";
import * as MachineSettings from "../../machine-settings.js";

/** This machine's repository decisions, as recorded. Never writes. */
export const readRepositoryDecisions = Effect.fn("Library.readRepositoryDecisions")(function* (
  home: string,
) {
  return { repositories: [...(yield* MachineSettings.read(home)).repositories] };
});

/** Record one repository as watched or ignored, or clear its decision, and report the rest. */
export const decideRepository = Effect.fn("Library.decideRepository")(function* (
  home: string,
  repository: string,
  status: "watched" | "ignored" | undefined,
) {
  return {
    repositories: (yield* MachineSettings.setRepositoryDecision(home, repository, status))
      .repositories,
  };
});
