import { serverBuild } from "./build-info.js";
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
    build: serverBuild,
    download: "/api/skits/{owner}/{slug}/releases/{version}/download",
    scopes: [
      ...(capabilities.library ? ["library:sync"] : []),
      ...(capabilities.authoring ? ["authoring:write"] : []),
      ...(capabilities.publication ? ["publication:write"] : []),
    ],
    ...(capabilities.authoring
      ? {
          authorSkits: "/api/author/skits",
          skit: "/api/skits/{owner}/{slug}",
          createDraft: "/api/skits",
          draft: "/api/skits/{owner}/{slug}/draft",
        }
      : {}),
    ...(capabilities.publication ? { publish: "/api/skits/{owner}/{slug}/releases" } : {}),
    // A CLI credential is worth minting only when some scope is on offer.
    ...(capabilities.library || capabilities.authoring || capabilities.publication
      ? { deviceAuthorization: "/api/auth/device/code", deviceToken: "/api/auth/device/token" }
      : {}),
  });

export const serverDiscovery = makeServerDiscovery({
  authoring: true,
  publication: true,
  library: true,
});
