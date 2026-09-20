import type { LibraryState, SkitSource } from "@smolai/skit-core";

type Upstream = NonNullable<LibraryState["collections"][number]["upstream"]>;

const gitRef = (base: string, upstream: Upstream, collectionRoot: string): string => {
  const parameters = new URLSearchParams();
  if (upstream.tracking.kind !== "default") parameters.set("ref", upstream.tracking.ref);
  if (collectionRoot !== ".") parameters.set("path", collectionRoot);
  if (upstream.selection.kind === "selected-paths")
    for (const path of upstream.selection.paths) parameters.append("skill", path);
  const fragment = parameters.toString();
  return fragment.length === 0 ? base : `${base}#${fragment}`;
};

/** Translate persisted refresh intent into the source resolver's input model. */
export const sourceFromUpstream = (upstream: Upstream): SkitSource | undefined => {
  const source = upstream.source_identity;
  switch (source.kind) {
    case "github":
      return {
        type: "git",
        locator: gitRef(
          `https://github.com/${source.owner}/${source.repository}.git`,
          upstream,
          source.collection_root,
        ),
      };
    case "git":
      return {
        type: "git",
        locator: gitRef(source.remote.value, upstream, source.collection_root),
      };
    case "registry":
      return {
        type: "registry",
        locator: `${source.namespace}/${source.slug}`,
        ...(source.authority === "default" ? {} : { authority: source.authority }),
      };
    case "url":
      return { type: "url", locator: source.url.value };
    case "archive":
      return { type: "archive", locator: source.url.value };
    case "well-known":
      return {
        type: "well-known",
        locator: source.locator.value,
        ...(upstream.selection.kind === "selected-skills"
          ? { members: upstream.selection.names }
          : {}),
      };
    case "local":
    case "authored-workspace":
      return undefined;
  }
};
