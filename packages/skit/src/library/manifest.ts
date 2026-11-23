import { Array, Order } from "effect";
import {
  currentLibraryManifest,
  type LibraryManifest,
  type Collection,
  type Skill,
  type CollectionVersion,
  type Import,
} from "./library-contracts.js";
import type { Enabled } from "./library-contracts.js";

const enabledKind = (item: Enabled) => ("collection" in item ? "collection" : "skill");
const enabledId = (item: Enabled) => ("collection" in item ? item.collection : item.skill);

type Catalogue = Pick<
  LibraryManifest,
  "collections" | "skills" | "collection_versions" | "imports"
>;

export function normalizeCatalogue<T extends Catalogue>(catalogue: T): T {
  return {
    ...catalogue,
    collections: Array.sort(
      catalogue.collections,
      Order.mapInput(Order.String, (item: Collection) => item.collection_id),
    ),
    skills: Array.sort(
      catalogue.skills.map((skill) => ({
        ...skill,
        versions: Array.sort(
          skill.versions,
          Order.mapInput(Order.String, (item: Skill["versions"][number]) => item.skill_version_id),
        ),
      })),
      Order.mapInput(Order.String, (item: Skill) => item.skill_id),
    ),
    collection_versions: Array.sort(
      catalogue.collection_versions.map((version) => ({
        ...version,
        members: Array.sort(
          version.members,
          Order.mapInput(
            Order.String,
            (item: CollectionVersion["members"][number]) => item.source_path,
          ),
        ),
      })),
      Order.mapInput(Order.String, (item: CollectionVersion) => item.collection_version_id),
    ),
    imports: Array.sort(
      catalogue.imports,
      Order.mapInput(Order.String, (item: Import) => item.import_id),
    ),
  };
}

export function normalizeLibraryManifest(manifest: LibraryManifest): LibraryManifest {
  return currentLibraryManifest({
    ...normalizeCatalogue(manifest),
    snapshot_digests: Array.sort(manifest.snapshot_digests, Order.String),
    enabled: Array.sort(
      manifest.enabled,
      Order.combine(
        Order.mapInput(Order.String, enabledKind),
        Order.mapInput(Order.String, enabledId),
      ),
    ),
  });
}
