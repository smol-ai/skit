import { Effect } from "effect";
import { openLibraryView } from "./library-view.js";
import type { SkitSource } from "../../library-contracts.js";
import type { Hash } from "../../../shared/hash.js";
import type { SourceInspection } from "./source-updates.js";

export const readLibraryWorkspaceClaims = Effect.fn("Library.readWorkspaceClaims")(function* (
  home: string,
  root: string,
) {
  return yield* (yield* openLibraryView(home)).readWorkspaceClaims(root);
});
export const readInstalledSkills = Effect.fn("Library.readInstalledSkills")(function* (
  home: string,
) {
  return (yield* openLibraryView(home)).installedSkills;
});
export const readLibraryManifest = Effect.fn("Library.readManifest")(function* (home: string) {
  return yield* (yield* openLibraryView(home)).readManifest();
});
export const readSkillsShCollectionIds = Effect.fn("Library.readSkillsShCollectionIds")(function* (
  home: string,
) {
  return (yield* openLibraryView(home)).skillsShCollectionIds;
});
export const readLibraryDescriptionLoad = Effect.fn("Library.readDescriptionLoad")(function* (
  home: string,
  subject: { readonly collection: string } | { readonly skills: readonly string[] },
) {
  return yield* (yield* openLibraryView(home)).descriptionLoad(subject);
});
export const reviewLibrarySecurity = Effect.fn("Library.reviewSecurity")(function* (
  home: string,
  query: string,
) {
  return yield* (yield* openLibraryView(home)).securityReview(query);
});
export const checkLibrarySubjects = Effect.fn("Library.checkSubjects")(function* <E, R>(
  home: string,
  query: string | undefined,
  options: {
    readonly inspectSource: (
      source: SkitSource,
    ) => Effect.Effect<{ readonly snapshot_digest: Hash }, E, R>;
    readonly onCollection?: (collection: {
      readonly collection_id: string;
      readonly display_name: string;
    }) => Effect.Effect<void>;
  },
) {
  return yield* (yield* openLibraryView(home)).checkSubjects(query, options);
});
export const previewLibrarySourceUpdates = Effect.fn("Library.previewSourceUpdates")(function* <
  E,
  R,
>(
  home: string,
  query: string | undefined,
  inspectSource: (
    input: SkitSource,
    previousSkillPaths?: readonly string[],
  ) => Effect.Effect<SourceInspection, E, R>,
) {
  return yield* (yield* openLibraryView(home)).previewSourceUpdates(query, inspectSource);
});

export const readLibraryList = Effect.fn("Library.readList")(function* (home: string) {
  const view = yield* openLibraryView(home);
  return {
    subjects: yield* view.readSubjects(),
    placements: view.placements,
    enabledEverywhere: view.enabledEverywhere,
  };
});
