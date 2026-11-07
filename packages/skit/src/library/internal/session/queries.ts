import type { TreeRequirements } from "../../../platform/tree-requirements.js";
import type { Digest } from "effect/crypto";
import type { HttpClient } from "effect/http";
import { Context, Effect, Option } from "effect";
import { join } from "node:path";
import type { Interface } from "../../library.js";
import { libraryView } from "./library-view.js";
import { emptyLibraryState } from "../../library-state.js";
import type { Snapshot } from "../../snapshot.js";
import type { LibraryStateReadError } from "../../store/library-store.js";
import type { SkitSource } from "../../library-contracts.js";
import type { Hash } from "../../../shared/hash.js";
import type { SourceInspection } from "./source-updates.js";

/**
 * The owner's passive reads over the Library at `home`, from the one read it supplies. Storage
 * stays inside the owner; the service's type never depends on these.
 */
export const libraryQueries = (
  read: Effect.Effect<Snapshot, LibraryStateReadError>,
  home: string,
  platform: Context.Context<TreeRequirements | Digest.Digest | HttpClient.HttpClient>,
) => {
  const open = Effect.map(read, (snapshot) =>
    libraryView(
      snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(),
      join(home, "originals"),
    ),
  );
  return {
    workspaceClaims: Effect.fn("Library.readWorkspaceClaims")(function* (root: string) {
      return yield* (yield* open).readWorkspaceClaims(root).pipe(Effect.provide(platform));
    }),
    installedSkills: Effect.map(open, (view) => view.installedSkills),
    manifest: Effect.flatMap(open, (view) => view.readManifest()).pipe(Effect.provide(platform)),
    skillsShCollectionIds: Effect.map(open, (view) => view.skillsShCollectionIds),
    descriptionLoad: Effect.fn("Library.readDescriptionLoad")(function* (
      subject: { readonly collection: string } | { readonly skills: readonly string[] },
    ) {
      return yield* (yield* open).descriptionLoad(subject).pipe(Effect.provide(platform));
    }),
    securityReview: Effect.fn("Library.reviewSecurity")(function* (query: string) {
      return yield* (yield* open).securityReview(query).pipe(Effect.provide(platform));
    }),
    check: Effect.fn("Library.checkSubjects")(function* <E, R>(
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
      return yield* (yield* open).checkSubjects(query, options).pipe(Effect.provide(platform));
    }),
    previewSourceUpdates: Effect.fn("Library.previewSourceUpdates")(function* <E, R>(
      query: string | undefined,
      inspectSource: (
        input: SkitSource,
        previousSkillPaths?: readonly string[],
      ) => Effect.Effect<SourceInspection, E, R>,
    ) {
      return yield* (yield* open)
        .previewSourceUpdates(query, inspectSource)
        .pipe(Effect.provide(platform));
    }),
    list: Effect.gen(function* () {
      const view = yield* open;
      return {
        subjects: yield* view.readSubjects(),
        placements: view.placements,
        enabledEverywhere: view.enabledEverywhere,
      };
    }).pipe(Effect.provide(platform)),
  };
};

/** Record one accepted security finding and report the review as it stands afterwards. */
export const acceptLibrarySecurityFinding = Effect.fn("Library.acceptSecurityFinding")(function* (
  library: Pick<Interface, "read" | "plan" | "apply">,
  query: string,
  input: {
    readonly fingerprint: Hash;
    readonly principal: string;
    readonly rationale: string;
    readonly expiresAt?: string;
  },
) {
  const plan = yield* library.plan(
    {
      _tag: "AcceptFinding",
      query,
      ...input,
      expiresAt: Option.fromNullishOr(input.expiresAt),
    },
    { base: yield* library.read },
  );
  return (yield* library.apply({ _tag: "Apply", plan })).result.review;
});
