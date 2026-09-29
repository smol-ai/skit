import type { LibraryState, SkitSource } from "@smolai/skit-core";

type Upstream = NonNullable<LibraryState["collections"][number]["upstream"]>;

/** Translate persisted refresh intent into the source resolver's input model: the whole Source. */
export const sourceFromUpstream = (upstream: Upstream): SkitSource | undefined => {
  const source = upstream.source_identity;
  const git = {
    ...(upstream.tracking.kind === "default" ? {} : { ref: upstream.tracking.ref }),
    ...((source.kind === "github" || source.kind === "git") && source.collection_root !== "."
      ? { subpath: source.collection_root }
      : {}),
  };
  switch (source.kind) {
    case "github":
      return { type: "github", owner: source.owner, repository: source.repository, ...git };
    case "git":
      return { type: "git", remote: source.remote.value, ...git };
    case "registry":
      return {
        type: "registry",
        namespace: source.namespace,
        slug: source.slug,
        ...(source.authority === "default" ? {} : { authority: source.authority }),
      };
    case "url":
      return { type: "url", url: source.url.value };
    case "archive":
      return { type: "archive", url: source.url.value };
    case "well-known":
      return { type: "well-known", origin: source.locator.value };
    case "local":
    case "authored-workspace":
      return undefined;
  }
};
