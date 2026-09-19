import type { CollectionIdentity } from "../contracts.js";
import type { MachineId } from "./entity-ids.js";
import { sanitizeSourceClaim } from "./acquisition-evidence.js";
import type { SourceIdentity } from "./library-contracts.js";

const registryParts = (value: string) => {
  const [namespace = "local", slug = value] = value.split("/", 2);
  return { namespace, slug };
};

export function sourceIdentityFromCollectionIdentity(
  identity: CollectionIdentity,
  machineId: MachineId,
  input: string,
): SourceIdentity;
export function sourceIdentityFromCollectionIdentity(
  identity: CollectionIdentity,
  machineId: undefined,
  input: string,
): SourceIdentity | undefined;
export function sourceIdentityFromCollectionIdentity(
  identity: CollectionIdentity,
  machineId: MachineId | undefined,
  input: string,
): SourceIdentity | undefined;
export function sourceIdentityFromCollectionIdentity(
  identity: CollectionIdentity,
  machineId: MachineId | undefined,
  input: string,
): SourceIdentity | undefined {
  switch (identity.profile) {
    case "github-collection":
      return {
        kind: "github",
        owner: identity.owner,
        repository: identity.repository.replace(/\.git$/, ""),
        collection_root: identity.path ?? ".",
      };
    case "git-collection":
      return {
        kind: "git",
        remote: { value: sanitizeSourceClaim(identity.remote) },
        collection_root: identity.path ?? ".",
      };
    case "local-collection":
      return machineId === undefined
        ? undefined
        : { kind: "local", machine_id: machineId, path: { value: identity.path } };
    case "archive-collection":
      return { kind: "archive", url: { value: sanitizeSourceClaim(identity.url) } };
    case "url-collection":
      return { kind: "url", url: { value: sanitizeSourceClaim(identity.url) } };
    case "authored-workspace":
      return { kind: "authored-workspace", workspace_id: identity.workspaceId };
    case "declared-skit":
      return {
        kind: "registry",
        authority: identity.authority ?? "default",
        ...registryParts(identity.skitId),
      };
    case "private-collection":
      return {
        kind: "registry",
        authority: "private",
        namespace: identity.namespace,
        slug: identity.slug,
      };
    default:
      return { kind: "well-known", locator: { value: sanitizeSourceClaim(input) } };
  }
}

export const sourceIdentityEquals = (left: SourceIdentity, right: SourceIdentity): boolean => {
  if (left.kind === "url" && right.kind === "well-known")
    return left.url.value === right.locator.value;
  if (left.kind === "well-known" && right.kind === "url")
    return left.locator.value === right.url.value;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "github":
      return (
        right.kind === "github" &&
        left.owner === right.owner &&
        left.repository === right.repository &&
        left.collection_root === right.collection_root
      );
    case "git":
      return (
        right.kind === "git" &&
        left.remote.value === right.remote.value &&
        left.collection_root === right.collection_root
      );
    case "registry":
      return (
        right.kind === "registry" &&
        left.authority === right.authority &&
        left.namespace === right.namespace &&
        left.slug === right.slug
      );
    case "url":
    case "archive":
      return right.kind === left.kind && left.url.value === right.url.value;
    case "local":
      return right.kind === "local" && left.path.value === right.path.value;
    case "authored-workspace":
      return right.kind === "authored-workspace" && left.workspace_id === right.workspace_id;
    case "well-known":
      return right.kind === "well-known" && left.locator.value === right.locator.value;
  }
};
