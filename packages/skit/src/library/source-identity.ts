import { basename } from "node:path";
import type { MachineId } from "./entity-ids.js";
import { sanitizeSourceClaim } from "./acquisition-evidence.js";
import type { SkitSource, SourceIdentity } from "./library-contracts.js";

export interface SourceDeclaration {
  readonly namespace: string;
  readonly slug: string;
  readonly authority?: string;
}

/**
 * GitHub owner and repository of an arbitrary Git remote (for example an SSH remote), so it gets
 * the same identity as the same repository added by URL.
 */
const githubRemote = (remote: string): { owner: string; repository: string } | undefined => {
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  return match?.[1] && match[2]
    ? { owner: match[1].toLowerCase(), repository: match[2].toLowerCase() }
    : undefined;
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
      namespace: declaration.namespace,
      slug: declaration.slug,
    };
  switch (source.type) {
    case "registry":
      return {
        kind: "registry",
        authority: source.authority ?? "default",
        namespace: source.namespace,
        slug: source.slug,
      };
    case "github":
      return {
        kind: "github",
        owner: source.owner.toLowerCase(),
        repository: source.repository.toLowerCase(),
        collection_root: source.subpath ?? ".",
      };
    case "git": {
      const remote = source.remote.replace(/\/$/, "");
      const github = githubRemote(remote);
      return github === undefined
        ? {
            kind: "git",
            remote: { value: sanitizeSourceClaim(remote) },
            collection_root: source.subpath ?? ".",
          }
        : { kind: "github", ...github, collection_root: source.subpath ?? "." };
    }
    case "local":
      return machineId === undefined
        ? undefined
        : { kind: "local", machine_id: machineId, path: { value: source.path } };
    case "archive":
      return { kind: "archive", url: { value: sanitizeSourceClaim(source.url) } };
    case "url":
      return { kind: "url", url: { value: sanitizeSourceClaim(source.url) } };
    case "well-known":
      return { kind: "well-known", locator: { value: sanitizeSourceClaim(source.origin) } };
  }
}

export const collectionLabelFromSource = (
  source: SkitSource,
  declaration?: SourceDeclaration,
): string => {
  if (declaration !== undefined) return `${declaration.namespace}/${declaration.slug}`;
  switch (source.type) {
    case "registry":
      return `${source.namespace}/${source.slug}`;
    case "github":
      return `${source.owner.toLowerCase()}/${source.repository.toLowerCase()}${source.subpath === undefined ? "" : `/${source.subpath}`}`;
    case "git": {
      const remote = source.remote.replace(/\/$/, "");
      const github = githubRemote(remote);
      const name =
        github === undefined
          ? remote.replace(/\.git$/, "")
          : `${github.owner}/${github.repository}`;
      return `${name}${source.subpath === undefined ? "" : `/${source.subpath}`}`;
    }
    case "local":
      return basename(source.path);
    case "archive":
    case "url": {
      const rawGithub = source.url.match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//i,
      );
      return rawGithub ? `${rawGithub[1]}/${rawGithub[2]}` : source.url;
    }
    case "well-known":
      return source.origin;
  }
};
