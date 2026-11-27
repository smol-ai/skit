import { readWorkspaceClaims } from "./workspace-claims.js";
import { previewSourceUpdates, type SourceInspection } from "./source-updates.js";
import { checkLibrarySubjects } from "./check.js";
import type { Hash } from "../../../shared/hash.js";
import { type SkitSource, currentCollectionSkills } from "../../library-contracts.js";
import { removalSummary } from "./remove.js";
import { securityReview } from "../security/review.js";
import { Service } from "../../service.js";
import {
  emptyLibraryState,
  libraryManifestFromLocalState,
  type LibraryState,
} from "../../library-state.js";
import { join } from "node:path";

import { Effect } from "effect";
import { readDescriptionLoad } from "./description-load.js";

import { libraryListing } from "./listing.js";
/** Internal constructor: derive a read model from the same snapshot used by a prepared action. */
export const libraryView = (
  current: LibraryState,
  home: string,
  authored?: Parameters<typeof previewSourceUpdates>[4],
) => {
  const originalsPath = join(home, "originals");
  const state = structuredClone(current);
  return {
    ...libraryListing(state, originalsPath, home),
    /** Portable data from this captured revision; returned documents cannot change the view. */
    readManifest: Effect.fn("LibraryView.readManifest")(function* () {
      return structuredClone(yield* libraryManifestFromLocalState(state));
    }),
    readWorkspaceClaims: (root: string) => readWorkspaceClaims(state, root, home),
    previewSourceUpdates: <E, R>(
      query: string | undefined,
      inspectSource: (
        input: SkitSource,
        previousSkillPaths?: readonly string[],
      ) => Effect.Effect<SourceInspection, E, R>,
    ) => previewSourceUpdates(state, query, inspectSource, home, authored),
    checkSubjects: <E, R>(
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
    ) =>
      checkLibrarySubjects(
        state,
        originalsPath,
        query,
        options.inspectSource,
        options.onCollection,
      ),
    removalSummary: (query: string) => removalSummary(state, home, query),
    securityReview: (query: string) => securityReview(state, originalsPath, query),
    descriptionLoad: (
      subject: { readonly collection: string } | { readonly skills: readonly string[] },
    ) => {
      const collection =
        "collection" in subject
          ? state.collections.find((item) => item.collection_id === subject.collection)
          : undefined;
      return readDescriptionLoad(
        state,
        originalsPath,
        "skills" in subject
          ? state.skills.filter((skill) => subject.skills.includes(skill.skill_id))
          : collection === undefined
            ? []
            : currentCollectionSkills(state, collection.collection_id),
      );
    },
  };
};

/** Open once; all queries describe this Library revision without saving or reconciling. */
export const openLibraryView = Effect.fn("LibraryView.open")(function* (home: string) {
  const snapshot = yield* (yield* Service).read;
  return libraryView(snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(), home);
});
