import { AuthorRemoteHome } from "../author/contracts.js";
import { Effect, FileSystem, Option, Schema } from "effect";
import {
  readDraftWorkspaceLocations,
  readAuthorIdentity,
  readAuthorRemote,
} from "../author/index.js";
import {
  SourceIdentity,
  sourceImports,
  type Collection,
  type LibraryManifest,
} from "./library-contracts.js";
import * as MachineSettings from "./machine-settings.js";
import { sourceIdentityLabel } from "./source-identity.js";

/** Source facts for local reports, not portable identity or enablement intent. */
export const CollectionSource = Schema.Struct({
  kind: Schema.Union(SourceIdentity.members.map((member) => member.fields.kind)),
  name: Schema.String,
  locator: Schema.String,
  authority: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
  workspace_status: Schema.optionalKey(
    Schema.Literals(["connected", "unconnected", "unavailable", "identity-mismatch", "ambiguous"]),
  ),
});
export type CollectionSource = typeof CollectionSource.Type;

/** One operation shares its first checkpoint and machine identity reads across Collections. */
export const workspaceLookup = Effect.fn("Library.workspaceLookup")(function* (home: string) {
  return {
    machine: yield* Effect.cached(MachineSettings.readIdentity(home)),
    drafts: yield* Effect.cached(readDraftWorkspaceLocations(home)),
  };
});
export type WorkspaceLookup = Effect.Success<ReturnType<typeof workspaceLookup>>;

/** A portable Draft selects a workspace only through this device's confirmed checkpoint. */
export const localWorkspaceLocations = Effect.fn("Library.localWorkspaceLocations")(function* (
  state: Pick<LibraryManifest, "imports">,
  collection: Collection,
  lookup: WorkspaceLookup,
) {
  const upstream = collection.upstream;
  const source = upstream?.source_identity;
  if (source?.kind !== "authored-workspace") return [];
  const ownerLocation = Effect.gen(function* () {
    const machine = yield* lookup.machine;
    const local = sourceImports(state, collection.collection_id).find(
      (item) =>
        machine !== undefined &&
        item.machine_id === machine &&
        item.source_identity.kind === "authored-workspace" &&
        item.source_identity.workspace_id === source.workspace_id,
    );
    return local ? { workspaceId: source.workspace_id, path: local.input.value } : undefined;
  });
  const draft = upstream?.draft_home;
  if (!draft) {
    const owner = yield* ownerLocation;
    return owner ? [owner] : [];
  }
  const recorded = (yield* lookup.drafts)(draft);
  const locations = [...recorded];
  if (!locations.length) {
    const owner = yield* ownerLocation;
    if (owner) locations.push(owner);
  }
  const fs = yield* FileSystem.FileSystem;
  const live = [];
  for (const location of locations) {
    const identity = yield* readAuthorIdentity(location.path).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.getOrUndefined(identity)?.workspaceId !== location.workspaceId) continue;
    const remote = yield* readAuthorRemote(location.path).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    const address = Option.getOrUndefined(remote);
    if (!address || !Schema.toEquivalence(AuthorRemoteHome)(address, draft)) continue;
    const path = yield* fs.realPath(location.path).pipe(Effect.option);
    if (Option.isSome(path)) live.push({ ...location, path: path.value });
  }
  return live;
});

export const localWorkspace = Effect.fn("Library.localWorkspace")(function* (
  state: Pick<LibraryManifest, "imports">,
  collection: Collection,
  lookup: WorkspaceLookup,
) {
  const locations = yield* localWorkspaceLocations(state, collection, lookup);
  return locations.length === 1 ? locations[0] : undefined;
});
/** Missing/broken workspace metadata must not hide its retained Library entry. Remote facts
 * are shown only when the live folder still has the identity this Collection owns. */
export const readCollectionSource = Effect.fn("Library.readCollectionSource")(function* (
  state: Pick<LibraryManifest, "imports">,
  collection: Collection,
  lookup: WorkspaceLookup,
): Effect.fn.Return<CollectionSource | undefined, never, FileSystem.FileSystem> {
  const acquisition = sourceImports(state, collection.collection_id)[0];
  const source = collection.upstream?.source_identity ?? acquisition?.source_identity;
  if (source === undefined) return undefined;
  if (source.kind === "authored-workspace") {
    const locations = yield* localWorkspaceLocations(state, collection, lookup).pipe(
      Effect.orElseSucceed(() => []),
    );
    const local = locations.length === 1 ? locations[0] : undefined;
    const locator = local?.path ?? "";
    const draft = collection.upstream?.draft_home;
    const base = {
      kind: source.kind,
      name: draft ? `${draft.namespace}/${draft.skit}` : collection.label,
      locator,
      ...(draft ? { authority: draft.origin } : {}),
    };
    if (locations.length > 1) return { ...base, workspace_status: "ambiguous" };
    if (!locator) return { ...base, workspace_status: "unavailable" };
    const identity = yield* readAuthorIdentity(locator).pipe(Effect.result);
    if (identity._tag === "Failure" || Option.isNone(identity.success))
      return { ...base, workspace_status: "unavailable" };
    if (identity.success.value.workspaceId !== local?.workspaceId)
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
