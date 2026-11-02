import { Effect } from "effect";
import { setEnabledAt, pruneEmptyEnabled, type LibraryState } from "./library-state.js";
import { calculateEnabled, expandIntent, type Request } from "./enabled-plan.js";
import { removeFromEnabled } from "./enabled.js";
import { CollectionRemovalMissing } from "./installation/remove.js";
import type { Intent } from "./library-plan.js";

type Calculated = Effect.Success<ReturnType<typeof calculateEnabled>>;

/** What each intent changes in the Library itself, before any copy is considered. */
export const edit = Effect.fn("Library.edit")(function* (base: LibraryState, intent: Intent) {
  switch (intent._tag) {
    case "Update":
    case "Uninstall":
      return { next: base, requests: [] };
    case "Remove": {
      if (!base.collections.some((item) => item.collection_id === intent.collectionId))
        return yield* new CollectionRemovalMissing({ collection_id: intent.collectionId });
      const skills = new Set<string>(
        base.skills
          .filter((skill) => skill.collection_id === intent.collectionId)
          .map((skill) => skill.skill_id),
      );
      const imports = base.imports.filter((item) => item.collection_id !== intent.collectionId);
      const surviving = new Set(imports.map((item) => item.collection_version_id));
      const pruned = removeFromEnabled(base, {
        skills,
        collections: new Set([intent.collectionId]),
      });
      return {
        next: {
          ...pruned,
          collections: pruned.collections.filter(
            (item) => item.collection_id !== intent.collectionId,
          ),
          skills: pruned.skills.filter((skill) => !skills.has(skill.skill_id)),
          imports,
          collection_versions: pruned.collection_versions.filter((version) =>
            surviving.has(version.collection_version_id),
          ),
        },
        requests: [],
      };
    }
    case "Enabled": {
      const requests = (yield* Effect.forEach(intent.changes, (change) =>
        expandIntent(base, change),
      )).flat();
      const edited = yield* Effect.reduce(
        requests,
        (): { next: LibraryState; requests: { request: Request; calculated: Calculated }[] } => ({
          next: base,
          requests: [],
        }),
        (sofar, request) =>
          Effect.map(calculateEnabled(sofar.next, request), (calculated) => ({
            next: calculated.plan.changed
              ? setEnabledAt(sofar.next, request.scope, calculated.plan)
              : sofar.next,
            requests: [...sofar.requests, { request, calculated }],
          })),
      );
      return {
        next: requests.some((request) => !request.enabled)
          ? pruneEmptyEnabled(edited.next)
          : edited.next,
        requests: edited.requests,
      };
    }
  }
});
