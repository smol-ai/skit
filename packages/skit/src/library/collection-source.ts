import { Effect, FileSystem, Option, Schema } from "effect";
import { readAuthorIdentity, readAuthorRemote } from "../author/workspace-metadata.js";
import { SourceIdentity, sourceImports, type Collection } from "./library-contracts.js";
import type { LibraryState } from "./library-state.js";
import { sourceIdentityLabel } from "./source-identity.js";

/** Source facts for local reports, not portable identity or enablement intent. */
export const CollectionSource = Schema.Struct({
  kind: Schema.Union(SourceIdentity.members.map((member) => member.fields.kind)),
  name: Schema.String,
  locator: Schema.String,
  authority: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
  workspace_status: Schema.optionalKey(
    Schema.Literals(["connected", "unconnected", "unavailable", "identity-mismatch"]),
  ),
});
export type CollectionSource = typeof CollectionSource.Type;

/** Missing/broken workspace metadata must not hide its retained Library entry. Remote facts
 * are shown only when the live folder still has the identity this Collection owns. */
export const readCollectionSource = Effect.fn("Library.readCollectionSource")(function* (
  state: LibraryState,
  collection: Collection,
): Effect.fn.Return<CollectionSource | undefined, never, FileSystem.FileSystem> {
  const acquisition = sourceImports(state, collection.collection_id)[0];
  const source = collection.upstream?.source_identity ?? acquisition?.source_identity;
  if (source === undefined) return undefined;
  if (source.kind === "authored-workspace") {
    const locator = acquisition?.input.value ?? "";
    const base = { kind: source.kind, name: collection.label, locator };
    if (!locator) return { ...base, workspace_status: "unavailable" };
    const identity = yield* readAuthorIdentity(locator).pipe(Effect.result);
    if (identity._tag === "Failure" || Option.isNone(identity.success))
      return { ...base, workspace_status: "unavailable" };
    if (identity.success.value.workspaceId !== source.workspace_id)
      return { ...base, workspace_status: "identity-mismatch" };
    const remote = yield* readAuthorRemote(locator).pipe(Effect.result);
    if (remote._tag === "Failure") return { ...base, workspace_status: "unavailable" };
    if (Option.isNone(remote.success)) return { ...base, workspace_status: "unconnected" };
    return {
      ...base,
      workspace_status: "connected",
      name: `${remote.success.value.namespace}/${remote.success.value.skit}`,
      authority: remote.success.value.origin,
    };
  }
  return {
    kind: source.kind,
    name: source.kind === "registry" ? `${source.namespace}/${source.slug}` : collection.label,
    locator: sourceIdentityLabel(source),
    ...(source.kind === "registry" ? { authority: source.authority } : {}),
    ...(acquisition?.revision === undefined ? {} : { revision: acquisition.revision }),
  };
});
