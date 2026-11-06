import type { Effect } from "effect";
import type * as Sync from "../sync/sync.js";
import type { SkitFailure } from "../shared/failure.js";
import type { AuthorRemoteHome, AuthorVisibility } from "./remote.js";
import type { DestinationExistsWithoutHistory } from "./failures.js";

/** Registry protocol only. Workspace recovery and all local writes belong to Author. */
export interface AuthorRegistry<E = SkitFailure, R = never, ProtocolError = E> {
  readonly origin: Effect.Effect<string | undefined, E, R>;
  readonly connect: (input: {
    readonly remote: AuthorRemoteHome;
    readonly locator: string;
    readonly requireAuthentication: boolean;
  }) => Effect.Effect<
    {
      readonly remote: Sync.Remote;
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
