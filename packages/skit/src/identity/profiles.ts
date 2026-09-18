import { basename } from "node:path";
import type { CollectionIdentity } from "../contracts.js";
import {
  defineCollectionIdentityProfile,
  type CollectionIdentityInput,
  type CollectionIdentityProfile,
} from "./contracts.js";

function gitParts(ref: string): { remote: string; path?: string; skillPaths: string[] } {
  const [remote, fragment = ""] = ref.split("#", 2);
  const values = new URLSearchParams(fragment);
  return {
    remote: remote.replace(/\/$/, ""),
    path: values.get("path") ?? undefined,
    skillPaths: [...new Set(values.getAll("skill"))].sort(),
  };
}

function githubParts(remote: string): { owner: string; repository: string } | undefined {
  const match = remote.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/i,
  );
  return match ? { owner: match[1].toLowerCase(), repository: match[2].toLowerCase() } : undefined;
}

const declaredSkitProfile = defineCollectionIdentityProfile("declared-skit", {
  recognitionPriority: 0,
  portable: true,
  recognize: (input: CollectionIdentityInput) => {
    if (input.declaration)
      return {
        profile: "declared-skit" as const,
        version: 1 as const,
        skitId: input.declaration.skitId,
        authority: input.declaration.authority,
      };
    if (input.source.type === "registry")
      return {
        profile: "declared-skit" as const,
        version: 1 as const,
        skitId: input.source.ref.split("@")[0],
      };
  },
  reference: (identity) =>
    identity.authority
      ? `skit:${identity.authority.replace(/\/$/, "")}/${identity.skitId}`
      : `skit:${identity.skitId}`,
  display: (identity) => identity.skitId,
});

const githubCollectionProfile = defineCollectionIdentityProfile("github-collection", {
  recognitionPriority: 10,
  portable: true,
  recognize: (input: CollectionIdentityInput) => {
    if (input.declaration || input.source.type !== "git") return;
    const { remote, path, skillPaths } = gitParts(input.source.ref);
    const github = githubParts(remote);
    return github
      ? {
          profile: "github-collection" as const,
          version: 1 as const,
          ...github,
          path,
          ...(skillPaths.length ? { skillPaths } : {}),
        }
      : undefined;
  },
  reference: (identity) => {
    const path = identity.path ? `?path=${encodeURIComponent(identity.path)}` : "";
    const skills = (identity.skillPaths ?? [])
      .map(
        (skillPath, index) =>
          `${path || index > 0 ? "&" : "?"}skill=${encodeURIComponent(skillPath)}`,
      )
      .join("");
    return `github:${identity.owner}/${identity.repository}${path}${skills}`;
  },
  display: (identity) =>
    `${identity.owner}/${identity.repository}${identity.path ? `/${identity.path}` : ""}`,
});

const gitCollectionProfile = defineCollectionIdentityProfile("git-collection", {
  recognitionPriority: 20,
  portable: true,
  recognize: (input: CollectionIdentityInput) => {
    if (input.declaration || input.source.type !== "git") return;
    const { remote, path, skillPaths } = gitParts(input.source.ref);
    return {
      profile: "git-collection" as const,
      version: 1 as const,
      remote,
      path,
      ...(skillPaths.length ? { skillPaths } : {}),
    };
  },
  reference: (identity) => {
    const path = identity.path
      ? `${identity.remote.includes("?") ? "&" : "?"}path=${encodeURIComponent(identity.path)}`
      : "";
    const skills = (identity.skillPaths ?? [])
      .map(
        (skillPath, index) =>
          `${path || index > 0 || identity.remote.includes("?") ? "&" : "?"}skill=${encodeURIComponent(skillPath)}`,
      )
      .join("");
    return `git:${identity.remote}${path}${skills}`;
  },
  display: (identity) =>
    identity.remote.replace(/\.git$/, "") + (identity.path ? `/${identity.path}` : ""),
});

const localCollectionProfile = defineCollectionIdentityProfile("local-collection", {
  recognitionPriority: 30,
  portable: false,
  recognize: (input: CollectionIdentityInput) =>
    !input.declaration && input.source.type === "local"
      ? { profile: "local-collection" as const, version: 1 as const, path: input.source.ref }
      : undefined,
  reference: (identity) => `local:${identity.path}`,
  display: (identity) => basename(identity.path),
});

const privateCollectionProfile = defineCollectionIdentityProfile("private-collection", {
  recognitionPriority: 32,
  portable: true,
  recognize: () => undefined,
  reference: (identity) => `private:${identity.namespace}/${identity.slug}`,
  display: (identity) => `${identity.namespace}/${identity.slug}`,
});

const authoredWorkspaceProfile = defineCollectionIdentityProfile("authored-workspace", {
  recognitionPriority: 35,
  portable: false,
  recognize: () => undefined,
  reference: (identity) => `authored:${identity.workspaceId}`,
  display: (identity) => identity.slug,
});

const archiveCollectionProfile = defineCollectionIdentityProfile("archive-collection", {
  recognitionPriority: 40,
  portable: true,
  recognize: (input: CollectionIdentityInput) =>
    !input.declaration && input.source.type === "archive"
      ? { profile: "archive-collection" as const, version: 1 as const, url: input.source.ref }
      : undefined,
  reference: (identity) => `archive:${identity.url}`,
  display: (identity) => identity.url,
});

const urlCollectionProfile = defineCollectionIdentityProfile("url-collection", {
  recognitionPriority: 50,
  portable: true,
  recognize: (input: CollectionIdentityInput) =>
    !input.declaration && (input.source.type === "url" || input.source.type === "well-known")
      ? {
          profile: "url-collection" as const,
          version: 1 as const,
          url:
            input.source.type === "well-known" && input.source.members?.length
              ? `${input.source.ref}#skills=${input.source.members.toSorted().join(",")}`
              : input.source.ref,
        }
      : undefined,
  reference: (identity) => `url:${identity.url}`,
  display: (identity) => {
    const rawGithub = identity.url.match(
      /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//i,
    );
    return rawGithub ? `${rawGithub[1]}/${rawGithub[2]}` : identity.url;
  },
});

export const collectionIdentityProfileCatalog = {
  [declaredSkitProfile.kind]: declaredSkitProfile,
  [githubCollectionProfile.kind]: githubCollectionProfile,
  [gitCollectionProfile.kind]: gitCollectionProfile,
  [localCollectionProfile.kind]: localCollectionProfile,
  [privateCollectionProfile.kind]: privateCollectionProfile,
  [authoredWorkspaceProfile.kind]: authoredWorkspaceProfile,
  [archiveCollectionProfile.kind]: archiveCollectionProfile,
  [urlCollectionProfile.kind]: urlCollectionProfile,
} as const satisfies Record<CollectionIdentity["profile"], CollectionIdentityProfile>;

export const collectionIdentityProfiles: readonly CollectionIdentityProfile[] = Object.freeze(
  Object.values(collectionIdentityProfileCatalog).sort(
    (left, right) => left.recognitionPriority - right.recognitionPriority,
  ),
);

export function assertCollectionIdentityCatalog(
  profiles: readonly CollectionIdentityProfile[] = collectionIdentityProfiles,
): void {
  const kinds = new Set<string>();
  for (const profile of profiles) {
    if (kinds.has(profile.kind))
      throw new Error(`Duplicate Collection Identity profile: ${profile.kind}`);
    kinds.add(profile.kind);
  }
  const expected = new Set(Object.keys(collectionIdentityProfileCatalog));
  for (const kind of expected)
    if (!kinds.has(kind)) throw new Error(`Missing Collection Identity profile: ${kind}`);
}

assertCollectionIdentityCatalog();
