import type { AuthorSkitSummary, AuthorSkitDeleteResponse } from "../api/authoring-contracts.js";
import type { ReleasePublishResponse } from "../api/index.js";
import type { Effect } from "effect";
import type * as Sync from "../sync/sync.js";
import type { SkitFailure } from "../shared/failure.js";
import type { AuthorRemoteHome, AuthorVisibility } from "./remote.js";
import type { DestinationExistsWithoutHistory } from "./failures.js";

/** Registry protocol only. Workspace recovery and all local writes belong to Author. */
export interface AuthorRegistry<E = SkitFailure, R = never, ProtocolError = E> {
  readonly list: Effect.Effect<
    { readonly origin: string; readonly skits: readonly AuthorSkitSummary[] },
    E,
    R
  >;
  readonly delete: (
    remote: AuthorRemoteHome,
    options: { readonly dryRun?: boolean },
  ) => Effect.Effect<AuthorSkitDeleteResponse, E, R>;
  readonly publish: (
    remote: AuthorRemoteHome,
  ) => Effect.Effect<
    (input: {
      readonly root: string;
      readonly version: string;
      readonly revision?: string;
      readonly archive: Uint8Array;
    }) => Effect.Effect<ReleasePublishResponse, ProtocolError>,
    E,
    R
  >;
  readonly origin: Effect.Effect<string | undefined, E, R>;
  readonly connect: (input: {
    readonly remote: AuthorRemoteHome;
    readonly locator: string;
    readonly requireAuthentication: boolean;
  }) => Effect.Effect<
    {
      readonly remote: Sync.Remote<ProtocolError>;
      readonly requireAvailable: Effect.Effect<
        void,
        ProtocolError | DestinationExistsWithoutHistory
      >;
      readonly create: (
        visibility: AuthorVisibility,
        requestId: string,
      ) => Effect.Effect<unknown, ProtocolError | DestinationExistsWithoutHistory>;
    },
    E,
    R
  >;
}
