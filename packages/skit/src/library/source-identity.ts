import { basename } from "node:path";
import type { SkitSource } from "./store/state-schema.js";
import type { MachineId } from "./entity-ids.js";
import { sanitizeSourceClaim } from "./acquisition-evidence.js";
import type { SourceIdentity } from "./library-contracts.js";

const registryParts = (value: string) => {
  const [namespace = "local", slug = value] = value.split("/", 2);
  return { namespace, slug };
};

export interface SourceDeclaration {
  readonly skitId: string;
  readonly authority?: string;
}

const gitParts = (locator: string) => {
  const [remote, fragment = ""] = locator.split("#", 2);
  const values = new URLSearchParams(fragment);
  return {
    remote: remote.replace(/\/$/, ""),
    collectionRoot: values.get("path") ?? ".",
  };
};

const githubParts = (remote: string): { owner: string; repository: string } | undefined => {
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  return match ? { owner: match[1].toLowerCase(), repository: match[2].toLowerCase() } : undefined;
};

export function sourceIdentityFromSource(
  source: SkitSource,
  machineId: MachineId,
  declaration?: SourceDeclaration,
): SourceIdentity;
export function sourceIdentityFromSource(
  source: SkitSource,
  machineId: undefined,
  declaration?: SourceDeclaration,
): SourceIdentity | undefined;
export function sourceIdentityFromSource(
  source: SkitSource,
  machineId: MachineId | undefined,
  declaration?: SourceDeclaration,
): SourceIdentity | undefined;
export function sourceIdentityFromSource(
  source: SkitSource,
  machineId: MachineId | undefined,
  declaration?: SourceDeclaration,
): SourceIdentity | undefined {
  if (declaration !== undefined)
    return {
      kind: "registry",
      authority: declaration.authority ?? "default",
      ...registryParts(declaration.skitId),
    };
  switch (source.type) {
    case "registry":
      return {
        kind: "registry",
        authority: source.authority ?? "default",
        ...registryParts(source.locator.split("@")[0]),
      };
    case "git": {
      const parts = gitParts(source.locator);
      const github = githubParts(parts.remote);
      return github === undefined
        ? {
            kind: "git",
            remote: { value: sanitizeSourceClaim(parts.remote) },
            collection_root: parts.collectionRoot,
          }
        : {
            kind: "github",
            ...github,
            collection_root: parts.collectionRoot,
          };
    }
    case "local":
      return machineId === undefined
        ? undefined
        : { kind: "local", machine_id: machineId, path: { value: source.locator } };
    case "archive":
      return { kind: "archive", url: { value: sanitizeSourceClaim(source.locator) } };
    case "url":
      return { kind: "url", url: { value: sanitizeSourceClaim(source.locator) } };
    case "well-known":
      return {
        kind: "well-known",
        locator: { value: sanitizeSourceClaim(source.locator) },
      };
  }
}

export const collectionLabelFromSource = (
  source: SkitSource,
  declaration?: SourceDeclaration,
): string => {
  if (declaration !== undefined) return declaration.skitId;
  switch (source.type) {
    case "registry":
      return source.locator.split("@")[0];
    case "git": {
      const parts = gitParts(source.locator);
      const github = githubParts(parts.remote);
      const root = parts.collectionRoot === "." ? "" : `/${parts.collectionRoot}`;
      return github === undefined
        ? `${parts.remote.replace(/\.git$/, "")}${root}`
        : `${github.owner}/${github.repository}${root}`;
    }
    case "local":
      return basename(source.locator);
    case "archive":
    case "url": {
      const rawGithub = source.locator.match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//i,
      );
      return rawGithub ? `${rawGithub[1]}/${rawGithub[2]}` : source.locator;
    }
    case "well-known":
      return source.locator;
  }
};

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
