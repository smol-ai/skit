import { localLibrary } from "./library-owner.js";
import { Effect } from "effect";
import { Library, LibraryStore } from "@smolai/skit-core";

/**
 * Install the selected Skills at one destination through the Library owner, planned against the
 * Library as it is now. Returns how many copies it wrote.
 */
export const installSkills = Effect.fn("Library.installSkills")(function* (
  install: Omit<Library.Install, "_tag">,
) {
  const store = yield* LibraryStore;
  const library = yield* localLibrary;
  const outcome = yield* library.apply(
    yield* library.plan([{ _tag: "Install", ...install }], { base: yield* store.load }),
  );
  return outcome._tag === "Applied"
    ? outcome.copies.filter((copy) => copy._tag === "Installed").length
    : 0;
});
