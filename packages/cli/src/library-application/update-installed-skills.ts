import { recordedLibrary } from "./library-owner.js";
import { Effect } from "effect";
import { Library, LibraryStore } from "@smolai/skit-core";

/**
 * Bring every installed copy up to date where it is, through the Library owner, with what the
 * user approved, planned against the Library as it is now. Returns how many copies it wrote.
 */
export const updateInstalledSkills = Effect.fn("Library.updateInstalledSkills")(function* (
  approvals: readonly Library.Approval[],
) {
  const state = yield* (yield* LibraryStore).load;
  const library = yield* recordedLibrary(state);
  const outcome = yield* library.apply(
    yield* library.plan({ _tag: "Update" }, { base: state, approvals }),
  );
  return outcome._tag === "Applied"
    ? outcome.copies.filter((copy) => copy._tag === "Installed").length
    : 0;
});
