import {
  serverDiscoverySchema,
  type ServerDiscovery as ServerDiscoveryDocument,
} from "@smolai/skit-core/universal/consumer";

export const ServerDiscovery = serverDiscoverySchema;
export type ServerDiscovery = ServerDiscoveryDocument;

export interface ServerCapabilities {
  readonly authoring?: boolean;
  readonly publication?: boolean;
  readonly library?: boolean;
}

/** Advertise only routes and scopes actually composed into this server edition. */
export const makeServerDiscovery = (capabilities: ServerCapabilities) =>
  serverDiscoverySchema.make({
    schema: "skit.server.v1",
    download: "/api/skits/{owner}/{slug}/releases/{version}/download",
    scopes: [
      ...(capabilities.library ? ["library:sync"] : []),
      ...(capabilities.authoring ? ["authoring:write"] : []),
      ...(capabilities.publication ? ["publication:write"] : []),
    ],
    ...(capabilities.library
      ? {
          library: "/api/library",
          sharedLibrary: "/api/libraries/{library_id}",
        }
      : {}),
    ...(capabilities.authoring
      ? {
          authorSkits: "/api/author/skits",
          skit: "/api/skits/{owner}/{slug}",
          createDraft: "/api/skits",
          draft: "/api/skits/{owner}/{slug}/draft",
        }
      : {}),
    ...(capabilities.publication ? { publish: "/api/skits/{owner}/{slug}/releases" } : {}),
  });

export const serverDiscovery = makeServerDiscovery({
  authoring: true,
  publication: true,
  library: true,
});
