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
import { suggestDoctorCleanup, type CleanupBudget } from "./cleanup-selection.js";
import type { UsageReport } from "../../usage/contracts.js";
import type { InventoryRootOptions } from "../../routing/roots.js";
import type { SourceInspection } from "./source-updates.js";
import type * as InstalledSkills from "../../installed-skills.js";

/**
 * Passive reports from the configured Library. An explicit base keeps displayed choices
 * and subsequent planning on the same revision; no query exposes a writer or query closures.
 */
export const libraryQueries = (
  read: Effect.Effect<Snapshot, LibraryStateReadError>,
  home: string,
  roots: InventoryRootOptions,
  platform: Context.Context<TreeRequirements | Digest.Digest | HttpClient.HttpClient>,
  files: InstalledSkills.Interface,
) => {
  const viewFor = (options?: { readonly base: Snapshot }) =>
    Effect.map(
      options === undefined ? read : Effect.succeed(structuredClone(options.base)),
      (snapshot) =>
        libraryView(
          snapshot._tag === "Present" ? snapshot.state : emptyLibraryState(),
          join(home, "originals"),
          { home, active: files.active },
        ),
    );
  return {
    workspaceClaims: Effect.fn("Library.readWorkspaceClaims")(function* (root: string) {
      return yield* (yield* viewFor()).readWorkspaceClaims(root).pipe(Effect.provide(platform));
    }),
    installedSkills: Effect.map(viewFor(), (view) => view.installedSkills),
    manifest: Effect.flatMap(viewFor(), (view) => view.readManifest()).pipe(
      Effect.provide(platform),
    ),
    skillsShCollectionIds: Effect.map(viewFor(), (view) => view.skillsShCollectionIds),
    descriptionLoad: Effect.fn("Library.readDescriptionLoad")(function* (
      subject: { readonly collection: string } | { readonly skills: readonly string[] },
      options?: { readonly base: Snapshot },
    ) {
      return yield* (yield* viewFor(options))
        .descriptionLoad(subject)
        .pipe(Effect.provide(platform));
    }),
    securityReview: Effect.fn("Library.reviewSecurity")(function* (query: string) {
      return yield* (yield* viewFor()).securityReview(query).pipe(Effect.provide(platform));
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
      return yield* (yield* viewFor()).checkSubjects(query, options).pipe(Effect.provide(platform));
    }),
    previewSourceUpdates: Effect.fn("Library.previewSourceUpdates")(function* <E, R>(
      query: string | undefined,
      inspectSource: (
        input: SkitSource,
        previousSkillPaths?: readonly string[],
      ) => Effect.Effect<SourceInspection, E, R>,
    ) {
      return yield* (yield* viewFor())
        .previewSourceUpdates(query, inspectSource)
        .pipe(Effect.provide(platform));
    }),
    skills: Effect.fn("Library.skills")(function* (options?: { readonly base: Snapshot }) {
      return yield* (yield* viewFor(options)).readSkills().pipe(Effect.provide(platform));
    }),
    suggestCleanup: (
      budgets: readonly CleanupBudget[],
      usage: UsageReport,
      options: { readonly base: Snapshot },
    ) =>
      suggestDoctorCleanup(
        options.base._tag === "Present" ? options.base.state : emptyLibraryState(),
        budgets,
        usage,
        roots,
      ),
    list: Effect.fn("Library.list")((options?: { readonly base: Snapshot }) =>
      Effect.gen(function* () {
        const view = yield* viewFor(options);
        const subjects = yield* view.readSubjects();
        return {
          subjects,
          collections: view.collections.map((collection) => ({
            ...collection,
            collectionSource: subjects.find((subject) => subject.id === collection.id)
              ?.collectionSource,
          })),
          installedSkills: view.installedSkills,
          placements: view.placements,
          enabledEverywhere: view.enabledEverywhere,
        };
      }).pipe(Effect.provide(platform)),
    ),
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
