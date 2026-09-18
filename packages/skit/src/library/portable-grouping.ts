import { collectionRef } from "../identity/catalog.js";
import type { CollectionIdentity } from "./store/state-schema.js";

const safePart = (part: string) => /^[a-z0-9_.-]+$/i.test(part);
const safeRelative = (path: string) =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !/^[a-z]:\//i.test(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** A GitHub-shaped grouping coordinate is a claim, never proof of authorship or Source bytes. */
export const portableGroupingKey = (identity: CollectionIdentity): string | undefined => {
  if (
    identity.profile !== "github-collection" ||
    !safePart(identity.owner) ||
    !safePart(identity.repository)
  )
    return undefined;
  if (identity.path !== undefined && !safeRelative(identity.path)) return undefined;
  if (identity.skillPaths?.some((path) => !safeRelative(path))) return undefined;
  return collectionRef(identity);
};
